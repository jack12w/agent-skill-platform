import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan, In } from 'typeorm';
import {
  Order,
  OrderItem,
  CreatorBalance,
  BalanceTransaction,
  Withdrawal,
  WechatNotifyLog,
  CreatorSubscription,
  Refund,
} from './payments.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { WechatPayService, WechatApiError } from './wechat-pay.service';
import { BalanceService } from './balance.service';

@Injectable()
export class AdminPaymentsService implements OnModuleInit {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem) private readonly itemRepo: Repository<OrderItem>,
    @InjectRepository(CreatorBalance) private readonly balRepo: Repository<CreatorBalance>,
    @InjectRepository(BalanceTransaction) private readonly txRepo: Repository<BalanceTransaction>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    @InjectRepository(Withdrawal) private readonly wdRepo: Repository<Withdrawal>,
    @InjectRepository(WechatNotifyLog) private readonly logRepo: Repository<WechatNotifyLog>,
    @InjectRepository(CreatorSubscription) private readonly csRepo: Repository<CreatorSubscription>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Team) private readonly teamRepo: Repository<Team>,
    private readonly wechat: WechatPayService,
    private readonly balance: BalanceService,
  ) {}

  private async paginate<T>(repo: Repository<T>, where: any, page: number, size: number, order: any = { created_at: 'DESC' }) {
    const [items, total] = await repo.findAndCount({ where, skip: (page - 1) * size, take: size, order });
    return { items, total, page, size };
  }

  async listOrders(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const r = await this.paginate(this.orderRepo, where, page, size);
    const items = await Promise.all(
      r.items.map(async (o: Order) => ({
        ...o,
        items: await this.itemRepo.find({ where: { order_id: o.id } }),
      })),
    );
    return { ...r, items };
  }

  async listMemberships(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const r = await this.paginate(this.csRepo, where, page, size, { started_at: 'DESC' });
    const subs = r.items as CreatorSubscription[];
    const subUserIds = [...new Set(subs.map((s) => s.user_id))];
    const targetUserIds = [...new Set(subs.filter((s) => s.target_type === 'user').map((s) => s.target_id))];
    const targetTeamIds = [...new Set(subs.filter((s) => s.target_type === 'team').map((s) => s.target_id))];
    const [subUsers, targetUsers, targetTeams] = await Promise.all([
      subUserIds.length ? this.userRepo.find({ where: { id: In(subUserIds) } }) : Promise.resolve([]),
      targetUserIds.length ? this.userRepo.find({ where: { id: In(targetUserIds) } }) : Promise.resolve([]),
      targetTeamIds.length ? this.teamRepo.find({ where: { id: In(targetTeamIds) } }) : Promise.resolve([]),
    ]);
    const subUserMap = new Map(subUsers.map((u) => [u.id, u]));
    const targetUserMap = new Map(targetUsers.map((u) => [u.id, u]));
    const targetTeamMap = new Map(targetTeams.map((t) => [t.id, t]));
    const items = subs.map((s) => {
      const targetName =
        s.target_type === 'team'
          ? (targetTeamMap.get(s.target_id) as any)?.name || s.target_id
          : (targetUserMap.get(s.target_id) as any)?.name || (targetUserMap.get(s.target_id) as any)?.username || s.target_id;
      const subscriberName =
        (subUserMap.get(s.user_id) as any)?.name || (subUserMap.get(s.user_id) as any)?.username || s.user_id;
      return { ...s, subscriber_name: subscriberName, target_name: targetName };
    });
    return { items, total: r.total, page, size };
  }

  /** 创作者余额列表（含邮箱） */
  async listCreators(page: number, size: number) {
    const [bals, total] = await this.balRepo.findAndCount({
      skip: (page - 1) * size,
      take: size,
      order: { available_cents: 'DESC' },
    });
    const userIds = bals.map((b) => b.user_id);
    const users = await this.userRepo.find({ where: { id: In(userIds) } });
    const map = new Map(users.map((u) => [u.id, u]));
    const items = bals.map((b) => ({
      ...b,
      email: map.get(b.user_id)?.email || '',
      name: (map.get(b.user_id) as any)?.name || '',
    }));
    return { items, total, page, size };
  }

  async listWithdrawals(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    return this.paginate(this.wdRepo, where, page, size, { applied_at: 'DESC' });
  }

  /** 审批并自动打款（商家转账到零钱） */
  /**
   * 定时同步「转账处理中」的提现单（每 2 分钟）。
   * 商家转账是异步接口，终态主要靠回调收口；回调可能丢失/延迟，
   * 这里用查单做兜底，与订单的 closeExpired 同一 setInterval 风格（零新依赖）。
   */
  onModuleInit() {
    setInterval(() => {
      this.syncProcessingWithdrawals().catch((e) => this.logger.warn('定时同步提现状态失败', e));
    }, 120_000).unref();
  }

  /**
   * 审批提现并发起微信打款。
   *
   * 资金安全两道闸：
   * ① 原子抢占 PENDING→REVIEWING。并发双击/双管理员同时审批时只有一路
   *    affected=1，另一路直接拒绝。否则两路都会执行 completeWithdraw，
   *    微信虽按 out_bill_no 幂等只打一笔款，但平台余额会被双扣、流水重复。
   * ② 商家转账是异步接口：创建成功只代表「已受理」。只有明确拿到 SUCCESS
   *    才标 PAID 并 completeWithdraw 核销余额；其余状态置 PROCESSING，
   *    由转账回调（transfer-notify）或定时查单收口，绝不提前核销。
   */
  async approveWithdrawal(id: string, adminId: string): Promise<Withdrawal> {
    const claimed = await this.wdRepo
      .createQueryBuilder()
      .update(Withdrawal)
      .set({ status: 'REVIEWING', reviewed_by: adminId, reviewed_at: new Date() })
      .where(`id = :id AND status = 'PENDING'`, { id })
      .execute();
    if (!(claimed.affected ?? 0)) throw new BadRequestException('该提现单已被处理，请刷新查看最新状态');

    const wd = await this.wdRepo.findOne({ where: { id } });
    if (!wd) throw new BadRequestException('提现单不存在');

    // 冻结余额（防并发重复提现）。申请之后若发生退款，余额可能已不足，
    // 此处必须捕获：否则提现单永久卡在 REVIEWING，且审批接口直接 500。
    try {
      await this.balance.freeze(wd.user_id, Number(wd.amount_cents));
    } catch (e: any) {
      await this.failWithdrawal(wd, e?.message || '余额不足，冻结失败');
      return (await this.wdRepo.findOne({ where: { id } }))!;
    }

    try {
      const r = await this.wechat.transferToBalance({
        outBillNo: wd.out_bill_no,
        openid: wd.target_openid!,
        amountCents: Number(wd.amount_cents),
        remark: 'SkillDepot 创作者收益',
        realName: wd.real_name || undefined,
      });
      // 按微信返回的转账单状态分流：仅 SUCCESS 是终态，其余（ACCEPTED/PROCESSING）等回调/查单
      if (r?.state === 'SUCCESS') {
        await this.completeWithdrawal(wd, r?.transfer_bill_no);
      } else {
        await this.wdRepo.update({ id: wd.id }, { status: 'PROCESSING', transfer_bill_no: r?.transfer_bill_no || null } as any);
        this.logger.log(`提现已受理（${r?.state || '未知状态'}），等待回调/查单收口: ${wd.out_bill_no}`);
      }
    } catch (e: any) {
      const isBizReject = e instanceof WechatApiError && e.wechatStatus >= 400 && e.wechatStatus < 500;
      if (isBizReject) {
        // 微信明确拒绝（参数/额度/收款人问题）→ 未受理，安全失败并解冻
        await this.failWithdrawal(wd, e?.message || '打款失败');
      } else {
        // 超时/网络/5xx：不确定微信是否受理。先用原 out_bill_no 查单核实
        //（微信对同单号幂等，绝不能在不确定时直接标失败放任人工重试）。
        try {
          const q = await this.wechat.queryTransfer(wd.out_bill_no);
          await this.applyTransferState(wd, q);
        } catch (qe: any) {
          if (qe instanceof WechatApiError && qe.wechatStatus === 404) {
            // 微信确认无此单 = 未受理 → 当场失败收口并解冻，管理员立即可见
            await this.failWithdrawal(wd, '打款未受理（微信无此单），已退回余额');
          } else {
            // 查单也不确定：置 PROCESSING（不解冻！），交给定时任务继续核实
            await this.wdRepo.update({ id: wd.id }, { status: 'PROCESSING' });
            this.logger.warn(`提现打款结果不确定且查单失败，置 PROCESSING 待核实: ${wd.out_bill_no}`);
          }
        }
      }
      if (isBizReject) this.logger.error(`提现打款失败 ${wd.out_bill_no}`, e);
    }
    return (await this.wdRepo.findOne({ where: { id } }))!;
  }

  /** 终态：打款成功（原子防重，completeWithdraw 只执行一次） */
  private async completeWithdrawal(wd: Withdrawal, transferBillNo?: string) {
    const r = await this.wdRepo
      .createQueryBuilder()
      .update(Withdrawal)
      .set({ status: 'PAID', transfer_bill_no: transferBillNo || wd.transfer_bill_no, paid_at: new Date() })
      .where(`id = :id AND status NOT IN ('PAID', 'FAILED', 'CANCELLED')`, { id: wd.id })
      .execute();
    if (!(r.affected ?? 0)) return; // 已被另一路（回调/查单）收口
    await this.balance.completeWithdraw(wd.user_id, Number(wd.amount_cents));
  }

  /** 终态：打款失败（原子防重，unfreeze 只执行一次） */
  private async failWithdrawal(wd: Withdrawal, reason: string) {
    const r = await this.wdRepo
      .createQueryBuilder()
      .update(Withdrawal)
      .set({ status: 'FAILED', fail_reason: (reason || '打款失败').slice(0, 200) })
      .where(`id = :id AND status NOT IN ('PAID', 'FAILED', 'CANCELLED')`, { id: wd.id })
      .execute();
    if (!(r.affected ?? 0)) return;
    await this.balance.unfreeze(wd.user_id, Number(wd.amount_cents));
  }

  /** 按微信转账单 state 收口（回调与查单共用） */
  private async applyTransferState(wd: Withdrawal, q: any) {
    const state = q?.state;
    if (state === 'SUCCESS') {
      await this.completeWithdrawal(wd, q?.transfer_bill_no);
    } else if (state === 'FAIL' || state === 'CANCELLED') {
      await this.failWithdrawal(wd, q?.fail_reason || `微信转账${state}`);
    } else {
      // ACCEPTED/PROCESSING 等中间态：确保本地至少为 PROCESSING
      if (wd.status === 'REVIEWING') {
        await this.wdRepo.update({ id: wd.id }, { status: 'PROCESSING' });
      }
    }
  }

  /** 定时兜底：同步 REVIEWING/PROCESSING 超过 60 秒的提现单 */
  private async syncProcessingWithdrawals() {
    const stuck = await this.wdRepo.find({
      where: [
        { status: 'PROCESSING' },
        { status: 'REVIEWING', reviewed_at: LessThan(new Date(Date.now() - 60_000)) },
      ],
      take: 20,
    });
    for (const wd of stuck) {
      try {
        const q = await this.wechat.queryTransfer(wd.out_bill_no);
        await this.applyTransferState(wd, q);
      } catch (e: any) {
        // 404 = 微信侧无此转账单 → 打款请求从未受理（如 freeze 后进程崩溃、请求未发出）。
        // 必须按失败收口并解冻余额，否则单子永久卡 REVIEWING、用户余额永久冻结。
        if (e instanceof WechatApiError && e.wechatStatus === 404) {
          this.logger.warn(`微信无此转账单，按打款未受理收口并解冻: ${wd.out_bill_no}`);
          await this.failWithdrawal(wd, '打款未受理（微信无此单），已自动退回余额');
        } else {
          this.logger.warn(`同步提现状态失败 ${wd.out_bill_no}: ${e?.message}`);
        }
      }
    }
  }

  /** 微信转账结果回调（transfer-notify 路由调用）：验签已在调用前完成 */
  async handleTransferNotify(decrypted: any) {
    const outBillNo = decrypted?.out_bill_no;
    if (!outBillNo) return;
    const wd = await this.wdRepo.findOne({ where: { out_bill_no: outBillNo } });
    if (!wd) {
      this.logger.warn(`转账回调单号不存在: ${outBillNo}`);
      return;
    }
    await this.applyTransferState(wd, decrypted);
  }

  async listRefunds(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const r = await this.paginate(this.refundRepo, where, page, size, { id: 'DESC' } as any);
    const orderIds = [...new Set((r.items as Refund[]).map((x) => x.order_id))];
    const orders = orderIds.length ? await this.orderRepo.find({ where: { id: In(orderIds) } }) : [];
    const map = new Map(orders.map((o) => [o.id, o]));
    return {
      ...r,
      items: (r.items as Refund[]).map((x) => ({
        ...x,
        order_no: map.get(x.order_id)?.order_no || '',
        order_type: map.get(x.order_id)?.type || '',
      })),
    };
  }

  /**
   * 微信回调原始日志（支付 + 退款通知）。排障用：
   * 回调失败/验签失败时管理员需要看到微信发来的原始报文与处理状态。
   */
  async listNotifyLogs(page: number, size: number, eventType?: string) {
    const where: any = {};
    if (eventType) where.event_type = eventType;
    return this.paginate(this.logRepo, where, page, size, { created_at: 'DESC' });
  }

  /**
   * 对账。原先只数了几个订单状态，回答不了"账对不上"这类问题。
   * 现在按金额做三组勾稽，任何一组不平都会给出明确的 diff 与可疑单据。
   */
  async reconcile() {
    const sum = async (repo: Repository<any>, col: string, alias: string, where?: string, params?: any) => {
      let qb = repo.createQueryBuilder('t').select(`COALESCE(SUM(t.${col}),0)`, 'v');
      if (where) qb = qb.where(where, params);
      const row = await qb.getRawOne<{ v: string }>();
      return Number(row?.v || 0);
    };

    // ── 1. 收入侧：订单实付 vs 已退款 ──
    const grossPaidCents = await sum(this.orderRepo, 'paid_cents', 'v', "t.status IN ('PAID','DELIVERED','REFUNDED','PARTIAL_REFUNDED')");
    const orderRefundedCents = await sum(this.orderRepo, 'refunded_cents', 'v');
    const refundSuccessCents = await sum(this.refundRepo, 'amount_cents', 'v', "t.status = 'SUCCESS'");
    const netRevenueCents = grossPaidCents - orderRefundedCents;

    // 订单上记的退款额，必须等于退款单里成功的合计
    const refundDiffCents = orderRefundedCents - refundSuccessCents;

    // ── 2. 分成侧：应付创作者 vs 实际入账流水 ──
    // 已交付订单里创作者应得合计（下单时就锁定的 seller_income_cents）
    const payableRow = await this.itemRepo
      .createQueryBuilder('i')
      .innerJoin(Order, 'o', 'o.id = i.order_id')
      .select('COALESCE(SUM(i.seller_income_cents),0)', 'v')
      .where("o.status IN ('DELIVERED','REFUNDED','PARTIAL_REFUNDED')")
      .andWhere('i.seller_user_id IS NOT NULL')
      .getRawOne<{ v: string }>();
    const payableCents = Number(payableRow?.v || 0);

    const creditedCents = await sum(this.txRepo, 'amount_cents', 'v', "t.direction = 'in'");
    const refundDeductCents = await sum(this.txRepo, 'amount_cents', 'v', "t.biz_type = 'refund_deduct'");
    // 入账流水 - 退款扣回 应当等于「已交付订单应付分成 - 已退款部分对应的分成」
    const settlementDiffCents = creditedCents - refundDeductCents - (payableCents - refundDeductCents);

    // ── 3. 余额侧：账面 vs 流水 ──
    const balanceAvailableCents = await sum(this.balRepo, 'available_cents', 'v');
    const balanceFrozenCents = await sum(this.balRepo, 'frozen_cents', 'v');
    const withdrawnCents = await sum(this.balRepo, 'total_withdrawn_cents', 'v');
    // 账面（可用+冻结+已提）应等于（累计入账 - 退款扣回）
    const balanceDiffCents =
      balanceAvailableCents + balanceFrozenCents + withdrawnCents - (creditedCents - refundDeductCents);

    // 平台留存 = 净收入 - 应付创作者（已扣退款）
    const platformCommissionCents = netRevenueCents - (payableCents - refundDeductCents);

    // ── 异常单据 ──
    const stuck = await this.orderRepo.find({
      where: { status: 'PENDING_PAY', expire_at: LessThan(new Date(Date.now() - 15 * 60_000)) },
      take: 50,
    });
    // 已付款但迟迟没交付（发货失败回滚会停在 PAID）
    const undelivered = await this.orderRepo.find({
      where: { status: 'PAID', paid_at: LessThan(new Date(Date.now() - 10 * 60_000)) },
      take: 50,
    });
    const pendingRefunds = await this.refundRepo.count({ where: { status: 'PENDING' } });
    const failedRefunds = await this.refundRepo.count({ where: { status: 'FAILED' } });
    // 余额为负 = 退款把创作者账户扣穿，需要人工追讨
    const negativeBalances = await this.balRepo.find({ where: { available_cents: LessThan(0) } as any, take: 50 });

    const unprocessedLogs = await this.logRepo.count({ where: { processed: false } });
    const recentLogs = await this.logRepo.find({ order: { created_at: 'DESC' }, take: 20 });

    const balanced = refundDiffCents === 0 && settlementDiffCents === 0 && balanceDiffCents === 0;

    return {
      balanced,
      amounts: {
        grossPaidCents,
        orderRefundedCents,
        refundSuccessCents,
        netRevenueCents,
        payableCents,
        creditedCents,
        refundDeductCents,
        platformCommissionCents,
        balanceAvailableCents,
        balanceFrozenCents,
        withdrawnCents,
      },
      diffs: { refundDiffCents, settlementDiffCents, balanceDiffCents },
      counts: {
        paidOrders: await this.orderRepo.count({ where: { status: 'PAID' } }),
        deliveredOrders: await this.orderRepo.count({ where: { status: 'DELIVERED' } }),
        refundedOrders: await this.orderRepo.count({ where: { status: 'REFUNDED' } }),
        processedLogs: await this.logRepo.count({ where: { processed: true } }),
        unprocessedLogs,
        pendingRefunds,
        failedRefunds,
        stuckCount: stuck.length,
        undeliveredCount: undelivered.length,
        negativeBalanceCount: negativeBalances.length,
      },
      stuck: stuck.map((o) => ({ order_no: o.order_no, created_at: o.created_at })),
      undelivered: undelivered.map((o) => ({ order_no: o.order_no, paid_at: o.paid_at, total_cents: o.total_cents })),
      negativeBalances: negativeBalances.map((b) => ({ user_id: b.user_id, available_cents: b.available_cents })),
      recentLogs: recentLogs.map((l) => ({ id: l.id, event_type: l.event_type, processed: l.processed, created_at: l.created_at })),
    };
  }
}
