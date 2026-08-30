import { Injectable, BadRequestException, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
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
import { DistributedStore } from '../common/dist-state.store';

/**
 * 对账链标记的保留时长：必须覆盖整条退避链（5s+20s+60s+3m+10m+30m ≈ 44.4min）
 * 再加首轮 0–3s 抖动，取 46min 留余量。仅作防泄漏兜底 —— 链正常结束会主动 unmark。
 */
const RECONCILE_CHAIN_TTL_SEC = 46 * 60;

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
export class RefundService implements OnModuleInit {
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
      // 仍 PENDING（微信已受理、待回调/待查单）→ 启动事件驱动退避链自动收口
      const saved = await this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
      if (saved && saved.status === 'PENDING') this.scheduleReconcile(outRefundNo);
      return saved;
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
          this.logger.warn(`退款已被微信受理（${q?.status || '未知状态'}），启动事件链收口: ${outRefundNo}`);
          this.scheduleReconcile(outRefundNo);
          return this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
        } catch (qe: any) {
          if (!(qe instanceof WechatApiError && qe.wechatStatus === 404)) {
            // 查单本身也失败（网络抖动等）：无法确定受理状态，保留 PENDING，
            // 由事件链退避重试或管理员在「退款记录」人工核实，额度保持占用以防超退。
            this.logger.warn(`退款申请与查单结果均不确定，启动事件链退避重试: ${outRefundNo}`);
            this.scheduleReconcile(outRefundNo);
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
   *
   * **并发安全（两处，都由事务内的订单行锁解决）**：
   * 1. 同一笔退款被并发 finalize：入口处「status 已是 SUCCESS 就退出」的检查在事务外，
   *    是典型的 check-then-act，两个调用可以同时通过它进入冲正 → 重复扣减创作者余额
   *    （debitForRefund 的幂等键能挡住重复记账，但权益撤销、订单回写仍会跑两遍）。
   * 2. 同一订单的两笔退款并发 finalize：两边都在 READ COMMITTED 下聚合「已 SUCCESS 的退款」，
   *    谁也看不见对方的成果，后写覆盖前写 → **refunded_cents 少算** →
   *    全额退款后 `fullyRefunded` 判 false → 权益/订阅漏撤销（用户白拿）、对账出现 diff。
   *
   * 因此在事务内先 `SELECT ... FOR UPDATE` 锁住订单行：同一订单的所有收口被串行化，
   * 拿到锁后再复查一次退款状态作为真正的原子闸门。
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

    // 冲正多步写（扣余额 + 撤权益 + 撤订阅 + 回写订单 + 标 SUCCESS）包进同一事务，
    // 任一步失败整体回滚，消除「余额已扣但权益未撤 / SUCCESS 未标」的中间态。
    await this.orderRepo.manager.transaction(async (manager) => {
      // 0. 锁订单行：串行化同一订单的并发收口（见方法注释的「并发安全」）。
      //    只按订单 id 加锁，不同订单之间互不影响，不会造成全局串行。
      const locked = await manager
        .createQueryBuilder()
        .select('o.id')
        .from(Order, 'o')
        .where('o.id = :id', { id: order.id })
        .setLock('pessimistic_write')
        .getOne();
      if (!locked) return; // 订单已被删除

      // 0.1 拿到锁后复查：把入口处非原子的 status 检查补成真正的原子闸门。
      //     此时同一订单的其他收口都在等这把锁，读到的状态是确定的。
      const fresh = await manager.findOne(Refund, { where: { out_refund_no: outRefundNo } });
      if (!fresh || fresh.status === 'SUCCESS') {
        this.logger.warn(`退款 ${outRefundNo} 已冲正（并发复查），跳过`);
        return;
      }

      // 1. 回冲创作者余额（按比例扣减当初入账的分成），并入同一事务
      for (const it of items) {
        const income = Number(it.seller_income_cents || 0);
        if (it.seller_user_id && income > 0) {
          const back = Math.round(income * ratio);
          if (back > 0) {
            await this.balance.debitForRefund(it.seller_user_id, back, refund.id, manager);
            this.logger.log(`退款冲正：创作者 ${it.seller_user_id} 扣回 ${back} 分（退款单 ${refund.out_refund_no}）`);
          }
        }
      }

      // 2. refunded_cents 由聚合计算（幂等）；全额退款才撤销权益/订阅
      const successRefunds = await manager.find(Refund, { where: { order_id: order.id, status: 'SUCCESS' } });
      const totalRefunded =
        successRefunds.reduce((s, r) => s + Number(r.amount_cents || 0), 0) + Number(refund.amount_cents);
      const fullyRefunded = totalRefunded >= paid;

      if (fullyRefunded) {
        if (order.type === 'skill') {
          for (const it of items) {
            if (it.subject_id) {
              await manager.delete(Entitlement, { user_id: order.user_id, skill_id: it.subject_id, order_id: order.id });
            }
          }
        } else if (order.type === 'creator_membership') {
          await manager
            .createQueryBuilder()
            .update(CreatorSubscription)
            .set({ status: 'refunded', expires_at: new Date() })
            .where('order_id = :oid', { oid: order.id })
            .execute();
        }
      }

      // 3. 回写订单（幂等）
      await manager.update(
        Order,
        { id: order.id },
        { refunded_cents: totalRefunded, status: fullyRefunded ? 'REFUNDED' : 'PARTIAL_REFUNDED' },
      );

      // 4. 最后原子标记 SUCCESS（仅结果标记；步骤幂等已防重复冲正）
      await manager.update(
        Refund,
        { out_refund_no: outRefundNo },
        { status: 'SUCCESS', refunded_at: new Date() },
      );
    });
  }

  /**
   * 事件驱动退款对账（主路径，零新依赖）。
   *
   * 设计动机：退款终态原本 100% 依赖微信异步退款回调；但回调可能延迟/丢失，或
   * WECHAT_PAY_PLATFORM_CERT 未配置导致 verifySignature fail-closed 被丢弃，此时 refund
   * 卡在 PENDING、订单永远停在 PAID。原先用一个 60–120s 常驻定时器兜底，但「永远在跑」
   * 不符合「空闲零开销」的诉求，故改为**事件驱动**：管理员点击「确认退款」且微信已受理
   * （退款单留在 PENDING）后，由本方法启动一条内存退避查单链，平时完全不占用任何资源。
   *
   * 退避链：起点 5s（满足「等 5 秒查一次」），随后 20s→60s→3m→10m→30m，封顶 6 次。
   * 每次 `reconcileOne`：SUCCESS→finalizeRefund 收口；CLOSED/ABNORMAL→标 FAILED；
   * PROCESSING 或网络抖动（超时/5xx）→ 进入下一次退避重试。链用尽仍非终态则清理标记，
   * 交给 onModuleInit 的慢速安全网兜底。
   *
   * 网络抖动处理：queryRefund 抛错（超时/连接重置/微信 5xx）时只记日志、保持 PENDING，
   * 由退避链自动重试，无需人工介入。
   */
  /**
   * 去重标记（原为进程内 Set）：多副本下各自为政会让同一退款单起 N 条退避链，
   * 重复查单既浪费额度又有触发微信频限的风险。迁入 Redis 后跨副本共享，
   * 「同一单只跑一条链」在所有副本上成立。
   * 注意：链本身仍跑在起链的那个副本里，进程重启后链会丢 —— 由 onModuleInit 的
   * 慢速安全网兜底，与改造前一致。
   */
  private readonly scheduled = new DistributedStore('pay:refund:reconcile');
  private readonly reconcileDelays = [5_000, 20_000, 60_000, 180_000, 600_000, 1_800_000];

  /**
   * 起链入口（同步，调用方无需 await）。
   * 去重标记要访问 Redis，真正的起链动作放在异步分支里，确认「首个标记者」后才执行。
   * 标记过程本身不会抛错（内部已降级），catch 仅为兜底：宁可重复起一条链，
   * 也绝不让退款单因去重失败而永远卡在 PENDING。
   */
  private scheduleReconcile(outRefundNo: string): void {
    void this.tryScheduleReconcile(outRefundNo).catch((e) => {
      this.logger.warn(`退款对账链去重标记异常，退化为本副本直接起链 ${outRefundNo}: ${e?.message}`);
      this.startReconcileChain(outRefundNo);
    });
  }

  private async tryScheduleReconcile(outRefundNo: string): Promise<void> {
    const isFirst = await this.scheduled.markOnce(outRefundNo, RECONCILE_CHAIN_TTL_SEC);
    if (!isFirst) return; // 已有副本（或本副本）在跑这条链
    this.startReconcileChain(outRefundNo);
  }

  private startReconcileChain(outRefundNo: string): void {
    let attempt = 0;
    const run = () => {
      this.reconcileOne(outRefundNo)
        .catch((e) => this.logger.warn(`事件驱动退款对账失败 ${outRefundNo}: ${e?.message}`))
        .finally(() => {
          attempt++;
          if (attempt < this.reconcileDelays.length) {
            setTimeout(run, this.reconcileDelays[attempt]).unref();
          } else {
            // 退避链用尽仍非终态：交慢速安全网兜底，清理本链标记
            void this.scheduled.unmark(outRefundNo).catch(() => {});
          }
        });
    };
    // 首次延迟加 0–3s 随机抖动，打散「短时间批量退款」导致的第 5 秒同刻爆发（避免触发微信频限）
    const firstDelay = this.reconcileDelays[0] + Math.floor(Math.random() * 3000);
    setTimeout(run, firstDelay).unref();
  }

  /** 单次退款查单 + 状态收口（事件链与安全网共用）。已终态/无单则只查不动。 */
  private async reconcileOne(outRefundNo: string): Promise<void> {
    const rf = await this.refundRepo.findOne({ where: { out_refund_no: outRefundNo } });
    if (!rf || rf.status !== 'PENDING') {
      await this.scheduled.unmark(outRefundNo); // 已被回调/其他路径收口，退出链
      return;
    }
    try {
      const q = await this.wechat.queryRefund(outRefundNo);
      if (!q) return; // 无结果：保持 PENDING，等下次
      if (q.status === 'SUCCESS') {
        await this.finalizeRefund(outRefundNo);
      } else if (q.status === 'CLOSED' || q.status === 'ABNORMAL') {
        await this.refundRepo.update(
          { out_refund_no: outRefundNo },
          { status: 'FAILED', reason: `${rf.reason || ''} | 微信终态:${q.status}`.slice(0, 200) },
        );
      }
      // PROCESSING 等中间态：保持 PENDING，等下次退避或回调收口
    } catch (e: any) {
      // 网络抖动/微信 5xx：记录后保持 PENDING，由退避链或安全网继续重试
      this.logger.warn(`退款查单网络异常 ${outRefundNo}: ${e?.message}`);
    }
  }

  /**
   * 慢速安全网（兜底，非主路径）。每 5 分钟只查「不在活跃退避链中的孤儿 PENDING」：
   * 即 api 进程重启丢失的链、或退避链用尽仍非终态的退款，防止其永久卡在 PENDING。
   * 平时几乎零开销（无孤儿 PENDING 时仅一次轻量 find 即返回，不碰微信接口）。
   */
  onModuleInit() {
    setInterval(() => {
      this.reconcileStuckRefunds().catch((e) => this.logger.warn('安全网对账退款失败', e));
    }, 300_000).unref();
  }

  async reconcileStuckRefunds(): Promise<void> {
    const pending = await this.refundRepo.find({ where: { status: 'PENDING' }, take: 100 });
    for (const rf of pending) {
      // 事件链还在跑（可能是别的副本起的）→ 跳过，避免重复查单
      if (await this.scheduled.exists(rf.out_refund_no)) continue;
      try {
        const q = await this.wechat.queryRefund(rf.out_refund_no);
        if (!q) continue;
        if (q.status === 'SUCCESS') {
          await this.finalizeRefund(rf.out_refund_no);
        } else if (q.status === 'CLOSED' || q.status === 'ABNORMAL') {
          await this.refundRepo.update(
            { out_refund_no: rf.out_refund_no },
            { status: 'FAILED', reason: `${rf.reason || ''} | 微信终态:${q.status}`.slice(0, 200) },
          );
        }
        // PROCESSING 等中间态：保持 PENDING，等下次安全网或回调收口
      } catch (e: any) {
        this.logger.warn(`安全网查单失败 ${rf.out_refund_no}: ${e?.message}`);
      }
    }
  }

  /** 某订单的退款记录（管理端展示） */
  async listByOrder(orderId: string): Promise<Refund[]> {
    return this.refundRepo.find({ where: { order_id: orderId } });
  }
}
