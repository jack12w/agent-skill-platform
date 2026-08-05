import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Refund,
  Entitlement,
  CreatorSubscription,
  WechatNotifyLog,
} from './payments.entity';
import { WechatPayService, WechatApiError } from './wechat-pay.service';
import { BalanceService } from './balance.service';

/**
 * 退款闭环。
 *
 * 此前系统只建了 refunds 表和 balance.debitForRefund()，但没有任何调用方：
 * 一旦发生退款，钱退给了买家，创作者余额却不回冲、权益/订阅也不撤销，
 * 平台净亏损且账目对不上。本服务补齐整条链路：
 *
 *   管理员发起 → 调微信退款 → 写 refunds(PENDING)
 *                              ↓ 微信退款结果回调
 *                        标记 SUCCESS → 冲正（回冲创作者余额 + 撤销权益/订阅 + 回写订单）
 *
 * 冲正金额按「本次退款额 ÷ 订单总额」的比例扣减创作者当初拿到的分成，
 * 保证部分退款也不会多扣或少扣。
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem) private readonly itemRepo: Repository<OrderItem>,
    @InjectRepository(Payment) private readonly payRepo: Repository<Payment>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    @InjectRepository(Entitlement) private readonly entRepo: Repository<Entitlement>,
    @InjectRepository(CreatorSubscription) private readonly csRepo: Repository<CreatorSubscription>,
    @InjectRepository(WechatNotifyLog) private readonly logRepo: Repository<WechatNotifyLog>,
    private readonly wechat: WechatPayService,
    private readonly balance: BalanceService,
  ) {}

  private genRefundNo(): string {
    return `RF${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  /**
   * 管理员发起退款。amountCents 缺省表示全额退。
   */
  async createRefund(orderNo: string, amountCents: number | undefined, reason: string, adminId: string) {
    const order = await this.orderRepo.findOne({ where: { order_no: orderNo } });
    if (!order) throw new NotFoundException('订单不存在');
    if (!['PAID', 'DELIVERED', 'PARTIAL_REFUNDED'].includes(order.status)) {
      throw new BadRequestException(`订单当前状态(${order.status})不可退款`);
    }

    // 权威闸门（纵深防御）：必须以 payments 表中 status='PAID' 的支付行为唯一事实来源。
    // order.status/paid_cents 仅是支付成功后的派生状态；即便未来出现脏数据或 order 字段被误改，
    // 只要底层 Payment 不是真实 PAID，一律拒绝退款，彻底杜绝「未支付却可退款」的任何路径。
    const payment = await this.payRepo.findOne({ where: { order_id: order.id, status: 'PAID' } });
    if (!payment) {
      throw new BadRequestException('订单无成功支付记录（payment 未 PAID），无法退款');
    }

    const paid = Number(order.paid_cents || 0);
    if (paid <= 0) throw new BadRequestException('订单无实付金额，无需退款');

    // 微信官方限制：同一笔订单最多发起 50 次部分退款
    const refundCount = await this.refundRepo.count({ where: { order_id: order.id } });
    if (refundCount >= 50) {
      throw new BadRequestException('该订单退款次数已达微信上限（50 次），无法继续发起退款');
    }

    // 悲观锁订单行，串行化同一订单的并发退款，杜绝「读已退金额→插退款单」的竞态导致超退。
    // 注意：锁仅覆盖「校验+插 PENDING 单」这段本地操作，微信网络调用在锁释放后进行，不持锁。
    let refund!: Refund;
    let outRefundNo!: string;
    let amount = 0;
    await this.orderRepo.manager.transaction(async (em) => {
      await em.findOne(Order, { where: { id: order.id }, lock: { mode: 'pessimistic_write' } });
      const rRepo = em.getRepository(Refund);
      const already = await rRepo
        .find({ where: { order_id: order.id } })
        .then((rows) =>
          rows
            .filter((r) => r.status === 'SUCCESS' || r.status === 'PENDING')
            .reduce((s, r) => s + Number(r.amount_cents || 0), 0),
        );
      const maxRefundable = paid - already;
      if (maxRefundable <= 0) throw new BadRequestException('该订单已全额退款');

      amount = amountCents == null ? maxRefundable : Math.round(Number(amountCents));
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('退款金额必须大于 0');
      if (amount > maxRefundable) {
        throw new BadRequestException(
          `退款金额超限：实付 ${(paid / 100).toFixed(2)} 元，已退/处理中 ${(already / 100).toFixed(2)} 元，本次最多可退 ${(maxRefundable / 100).toFixed(2)} 元`,
        );
      }

      outRefundNo = this.genRefundNo();
      refund = rRepo.create({
        order_id: order.id,
        payment_id: payment?.id ?? null,
        out_refund_no: outRefundNo,
        amount_cents: amount,
        reason: reason || '管理员退款',
        status: 'PENDING',
        applied_by: adminId,
        reviewed_by: adminId,
      });
      await rRepo.save(refund);
    });

    try {
      const r = await this.wechat.refund({
        outTradeNo: order.order_no,
        outRefundNo,
        refundCents: amount,
        totalCents: paid,
        reason: reason || '管理员退款',
      });
      await this.refundRepo.update({ out_refund_no: outRefundNo }, { refund_id: r?.refund_id });

      // 微信可能同步就返回 SUCCESS（余额充足时），此时不必等回调
      if (r?.status === 'SUCCESS') {
        await this.finalizeRefund(outRefundNo);
      }
      return this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
    } catch (e: any) {
      // 微信官方规范：退款失败重试必须复用原 out_refund_no（换新单号 = 可能退两次）。
      // 因此这里要区分失败性质：
      //   4xx 业务拒绝 → 微信明确未受理，标 FAILED 释放额度，重试新单号安全；
      //   超时/网络/5xx → 结果不确定（微信可能已受理），绝不能盲目标 FAILED 放任重试，
      //     必须用原单号主动查退款核实：已受理→按真实状态处理/保留 PENDING 等回调；
      //     确认无此单（404）→ 未受理，才可安全标 FAILED。
      const isBizReject = e instanceof WechatApiError && e.wechatStatus >= 400 && e.wechatStatus < 500;

      if (!isBizReject) {
        try {
          const q = await this.wechat.queryRefund(outRefundNo);
          if (q?.status === 'SUCCESS') {
            this.logger.warn(`退款申请超时但微信已成功（${outRefundNo}），按成功收口`);
            await this.finalizeRefund(outRefundNo);
            return this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
          }
          // PROCESSING / ABNORMAL 等：微信已受理，保留 PENDING 等退款回调收口
          this.logger.warn(`退款已被微信受理（${q?.status || '未知状态'}），保留 PENDING 等待回调: ${outRefundNo}`);
          return this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
        } catch (qe: any) {
          if (!(qe instanceof WechatApiError && qe.wechatStatus === 404)) {
            // 查单本身也失败（网络抖动等）：无法确定受理状态，保留 PENDING，
            // 由退款回调或管理员在「退款记录」人工核实，额度保持占用以防超退。
            this.logger.warn(`退款申请与查单结果均不确定，保留 PENDING 待回调/人工核实: ${outRefundNo}`);
            return this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
          }
          // 404 = 微信确认无此退款单 → 未受理，fallthrough 标 FAILED
        }
      }

      await this.refundRepo.update(
        { out_refund_no: outRefundNo },
        { status: 'FAILED', reason: `${reason || ''} | 失败:${e?.message || '未知'}`.slice(0, 200) },
      );
      this.logger.error(`退款申请失败 ${outRefundNo}: ${e?.message}`);
      throw new BadRequestException(`退款失败：${e?.message || '微信接口异常'}`);
    }
  }

  /** 微信退款结果回调 */
  async handleRefundNotify(rawBody: string, headers: Record<string, string>): Promise<{ code: string }> {
    const sig = headers['wechatpay-signature'] || headers['Wechatpay-Signature'];
    const ts = headers['wechatpay-timestamp'] || headers['Wechatpay-Timestamp'];
    const nonce = headers['wechatpay-nonce'] || headers['Wechatpay-Nonce'];

    if (!this.wechat.verifySignature(ts, nonce, rawBody, sig)) {
      this.logger.error('退款回调验签失败');
      throw new BadRequestException('签名验证失败');
    }

    const payload = JSON.parse(rawBody);
    const decrypted = this.wechat.decryptResource(payload.resource);

    await this.logRepo.save(
      this.logRepo.create({
        event_type: payload.event_type,
        resource_id: payload.resource?.id || payload.id,
        raw_body: rawBody,
        processed: true,
      }),
    );

    const outRefundNo = decrypted?.out_refund_no;
    if (!outRefundNo) return { code: 'SUCCESS' };

    if (decrypted.refund_status === 'SUCCESS') {
      await this.finalizeRefund(outRefundNo);
    } else {
      await this.refundRepo.update({ out_refund_no: outRefundNo }, { status: 'FAILED' });
      this.logger.warn(`退款失败回调 ${outRefundNo}: ${decrypted.refund_status}`);
    }
    return { code: 'SUCCESS' };
  }

  /**
   * 退款成功后的冲正。
   *
   * 设计原则（与 deliver 一致）：**各步骤幂等**，SUCCESS 标记放在最后作为结果标记，
   * 而非前置闸门。debitForRefund 以退款单 id 为幂等键（见下方调用）；
   * 权益/订阅撤销为幂等写操作；
   * refunded_cents 由「该订单所有 SUCCESS 退款聚合 + 本次金额」计算得出（非累加），
   * 因此重复调用不会产生重复冲正或重复累加。
   *
   * 若冲正中途失败，SUCCESS 未标记 → 微信退款回调重发或管理员重试时再次进入，
   * 幂等步骤从上次成功断点继续，直至全部完成，不存在「已退款但权益未撤销」的死状态。
   */
  async finalizeRefund(outRefundNo: string): Promise<void> {
    const refund = await this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
    if (!refund) return;
    if (refund.status === 'SUCCESS') {
      this.logger.warn(`退款 ${outRefundNo} 已冲正，跳过`);
      return;
    }

    const order = await this.orderRepo.findOne({ where: { id: refund.order_id } });
    if (!order) return;

    const items = await this.itemRepo.find({ where: { order_id: order.id } });
    const paid = Number(order.paid_cents || 0) || 1;
    const ratio = Number(refund.amount_cents) / paid;

    // 1. 回冲创作者余额（按比例扣减当初入账的分成）。
    //    ref_id 必须用「退款单 id」而非订单 id：同一订单多次（部分）退款时，
    //    每笔退款才能拿到独立幂等键，否则后续退款的扣回会被唯一索引吞掉 → 创作者少扣（HIGH-2）。
    for (const it of items) {
      const income = Number(it.seller_income_cents || 0);
      if (it.seller_user_id && income > 0) {
        const back = Math.round(income * ratio);
        if (back > 0) {
          await this.balance.debitForRefund(it.seller_user_id, back, refund.id);
          this.logger.log(`退款冲正：创作者 ${it.seller_user_id} 扣回 ${back} 分（退款单 ${refund.out_refund_no}）`);
        }
      }
    }

    // refunded_cents 由聚合计算（幂等），而非累加，避免重发导致重复计数
    const successRefunds = await this.refundRepo.find({ where: { order_id: order.id, status: 'SUCCESS' } });
    const totalRefunded =
      successRefunds.reduce((s, r) => s + Number(r.amount_cents || 0), 0) + Number(refund.amount_cents);
    const fullyRefunded = totalRefunded >= paid;

    // 2. 全额退款才撤销已发放的权益 / 订阅；部分退款保留（视为折价补偿）
    if (fullyRefunded) {
      if (order.type === 'skill') {
        for (const it of items) {
          if (it.subject_id) {
            await this.entRepo.delete({ user_id: order.user_id, skill_id: it.subject_id, order_id: order.id });
          }
        }
      } else if (order.type === 'creator_membership') {
        await this.csRepo
          .createQueryBuilder()
          .update(CreatorSubscription)
          .set({ status: 'refunded', expires_at: new Date() })
          .where('order_id = :oid', { oid: order.id })
          .execute();
      }
    }

    // 3. 回写订单（幂等）
    await this.orderRepo.update(
      { id: order.id },
      { refunded_cents: totalRefunded, status: fullyRefunded ? 'REFUNDED' : 'PARTIAL_REFUNDED' },
    );

    // 4. 最后原子标记 SUCCESS（仅结果标记；步骤幂等已防重复冲正）
    await this.refundRepo
      .createQueryBuilder()
      .update(Refund)
      .set({ status: 'SUCCESS', refunded_at: new Date() })
      .where('out_refund_no = :no AND status <> :s', { no: outRefundNo, s: 'SUCCESS' })
      .execute();
  }

  /** 某订单的退款记录（管理端展示） */
  async listByOrder(orderId: string): Promise<Refund[]> {
    return this.refundRepo.find({ where: { order_id: orderId } });
  }
}
