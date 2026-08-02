import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Refund,
  Entitlement,
  CreatorSubscription,
  WechatNotifyLog,
} from './payments.entity';
import { WechatPayService } from './wechat-pay.service';
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

  /** 已成功退款 + 退款处理中的合计，用于校验不超退 */
  private async refundedSoFar(orderId: string): Promise<number> {
    const rows = await this.refundRepo.find({ where: { order_id: orderId } });
    return rows
      .filter((r) => r.status === 'SUCCESS' || r.status === 'PENDING')
      .reduce((s, r) => s + Number(r.amount_cents || 0), 0);
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

    const paid = Number(order.paid_cents || 0);
    if (paid <= 0) throw new BadRequestException('订单无实付金额，无需退款');

    const already = await this.refundedSoFar(order.id);
    const maxRefundable = paid - already;
    if (maxRefundable <= 0) throw new BadRequestException('该订单已全额退款');

    const amount = amountCents == null ? maxRefundable : Math.round(Number(amountCents));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('退款金额必须大于 0');
    if (amount > maxRefundable) {
      throw new BadRequestException(
        `退款金额超限：实付 ${(paid / 100).toFixed(2)} 元，已退/处理中 ${(already / 100).toFixed(2)} 元，本次最多可退 ${(maxRefundable / 100).toFixed(2)} 元`,
      );
    }

    const payment = await this.payRepo.findOne({ where: { order_id: order.id, status: 'PAID' } });
    const outRefundNo = this.genRefundNo();

    const refund = this.refundRepo.create({
      order_id: order.id,
      payment_id: payment?.id ?? null,
      out_refund_no: outRefundNo,
      amount_cents: amount,
      reason: reason || '管理员退款',
      status: 'PENDING',
      applied_by: adminId,
      reviewed_by: adminId,
    } as any);
    await this.refundRepo.save(refund);

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
   * 退款成功后的冲正。用原子抢占保证幂等 —— 微信退款回调同样会重发。
   */
  async finalizeRefund(outRefundNo: string): Promise<void> {
    const claim = await this.refundRepo
      .createQueryBuilder()
      .update(Refund)
      .set({ status: 'SUCCESS', refunded_at: new Date() })
      .where('out_refund_no = :no AND status <> :s', { no: outRefundNo, s: 'SUCCESS' })
      .execute();
    if (!(claim.affected ?? 0)) {
      this.logger.warn(`退款 ${outRefundNo} 已冲正，跳过`);
      return;
    }

    const refund = await this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
    if (!refund) return;
    const order = await this.orderRepo.findOne({ where: { id: refund.order_id } });
    if (!order) return;

    const items = await this.itemRepo.find({ where: { order_id: order.id } });
    const paid = Number(order.paid_cents || 0) || 1;
    const ratio = Number(refund.amount_cents) / paid;

    // 1. 回冲创作者余额（按退款比例扣减当初入账的分成，允许扣成负数挂账）
    for (const it of items) {
      const income = Number(it.seller_income_cents || 0);
      if (it.seller_user_id && income > 0) {
        const back = Math.round(income * ratio);
        if (back > 0) {
          await this.balance.debitForRefund(it.seller_user_id, back, order.id);
          this.logger.log(`退款冲正：创作者 ${it.seller_user_id} 扣回 ${back} 分（订单 ${order.order_no}）`);
        }
      }
    }

    const totalRefunded = Number(order.refunded_cents || 0) + Number(refund.amount_cents);
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

    // 3. 回写订单
    await this.orderRepo.update(
      { id: order.id },
      { refunded_cents: totalRefunded, status: fullyRefunded ? 'REFUNDED' : 'PARTIAL_REFUNDED' },
    );
  }

  /** 某订单的退款记录（管理端展示） */
  async listByOrder(orderId: string): Promise<Refund[]> {
    return this.refundRepo.find({ where: { order_id: orderId } });
  }
}
