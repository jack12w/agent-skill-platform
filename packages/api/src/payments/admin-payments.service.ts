import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan, In, DataSource } from 'typeorm';
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

  // 提现收口安全闸：累计 404 次数（仅 REVIEWING，防瞬时误判）；僵尸单告警去重（进程级，重启后重报一次可接受）
  private readonly notFoundCounts = new Map<string, number>();
  private readonly zombieAlerted = new Set<string>();

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
    private readonly dataSource: DataSource,
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
    // 原子抢占 PENDING→REVIEWING 并冻结余额：同一事务，要么都成要么都回滚，
    // 消除「状态已翻 REVIEWING 但余额未冻结 / 冻结成功却状态未翻」的中间态。
    type ClaimResult =
      | { kind: 'skipped' }
      | { kind: 'failed' }
      | { kind: 'ok'; wd: Withdrawal };

    const result = await this.dataSource.transaction<ClaimResult>(async (manager) => {
      const claimed = await manager
        .createQueryBuilder()
        .update(Withdrawal)
        .set({ status: 'REVIEWING', reviewed_by: adminId, reviewed_at: new Date() })
        .where(`id = :id AND status = 'PENDING'`, { id })
        .execute();
      if (!(claimed.affected ?? 0)) return { kind: 'skipped' };

      const wd = await manager.findOne(Withdrawal, { where: { id } });
      if (!wd) return { kind: 'skipped' };

      try {
        await this.balance.freeze(wd.user_id, Number(wd.amount_cents), manager);
      } catch (e: any) {
        // 冻结失败（余额不足）：freeze 的 UPDATE 因可用不足未改行，本事务内标记 FAILED 并提交；
        // 不误解冻（从未冻结），与旧逻辑一致。
        await manager.update(
          Withdrawal,
          { id: wd.id },
          { status: 'FAILED', fail_reason: (e?.message || '余额不足，冻结失败').slice(0, 200) } as any,
        );
        return { kind: 'failed' };
      }
      return { kind: 'ok', wd };
    });

    if (result.kind === 'skipped') throw new BadRequestException('该提现单已被处理，请刷新查看最新状态');
    if (result.kind === 'failed') return (await this.wdRepo.findOne({ where: { id } }))!;
    const wd = result.wd;

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
            // 刚发起即查单返回 404：微信要求受理≥1分钟才可查单，瞬时"不存在"不能当作未受理。
            // 置 PROCESSING 交给定时任务在 30min 窗口+多次确认后决策，避免误解冻导致重复打款。
            await this.wdRepo.update({ id: wd.id }, { status: 'PROCESSING' } as any);
            this.logger.warn(`提现打款结果不确定且刚查单404，置 PROCESSING 待定时任务核实: ${wd.out_bill_no}`);
          } else {
            // 查单也不确定：置 PROCESSING（不解冻！），交给定时任务继续核实
            await this.wdRepo.update({ id: wd.id }, { status: 'PROCESSING' } as any);
            this.logger.warn(`提现打款结果不确定且查单失败，置 PROCESSING 待核实: ${wd.out_bill_no}`);
          }
        }
      }
      if (isBizReject) this.logger.error(`提现打款失败 ${wd.out_bill_no}`, e);
    }
    return (await this.wdRepo.findOne({ where: { id } }))!;
  }

  /**
   * 终态：打款成功。状态翻转与余额核销放进同一个 DB 事务（LOW-1 优化）——
   * 余额核销若失败，整笔回滚、状态退回 PROCESSING，下次回调/查单可安全重试，
   * 不再依赖 reconcile 兜底极端崩溃瞬间（旧实现：状态已标 PAID 但余额未扣，需对账补）。
   */
  private async completeWithdrawal(wd: Withdrawal, transferBillNo?: string) {
    await this.dataSource.transaction(async (manager) => {
      const r = await manager
        .createQueryBuilder()
        .update(Withdrawal)
        .set({ status: 'PAID', transfer_bill_no: transferBillNo || wd.transfer_bill_no, paid_at: new Date() })
        .where(`id = :id AND status NOT IN ('PAID', 'FAILED', 'CANCELLED')`, { id: wd.id })
        .execute();
      if (!(r.affected ?? 0)) return; // 已被另一路（回调/查单）收口
      const amt = Number(wd.amount_cents);
      await manager.increment(CreatorBalance, { user_id: wd.user_id }, 'frozen_cents', -amt);
      await manager.increment(CreatorBalance, { user_id: wd.user_id }, 'total_withdrawn_cents', amt);
      const bal = await manager.findOne(CreatorBalance, { where: { user_id: wd.user_id } });
      await manager.insert(BalanceTransaction, {
        user_id: wd.user_id,
        direction: 'out',
        amount_cents: amt,
        balance_after_cents: bal?.available_cents ?? 0,
        biz_type: 'withdraw',
      } as any);
    });
  }

  /**
   * 终态：打款失败。状态翻转与解冻放进同一事务（LOW-1 优化）：
   * 解冻若失败整笔回滚、状态退回非终态，下次同步可重试，避免旧实现里
   * 「已标 FAILED 但冻结未释放」导致的余额永久冻结。
   */
  private async failWithdrawal(wd: Withdrawal, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const r = await manager
        .createQueryBuilder()
        .update(Withdrawal)
        .set({ status: 'FAILED', fail_reason: (reason || '打款失败').slice(0, 200) })
        .where(`id = :id AND status NOT IN ('PAID', 'FAILED', 'CANCELLED')`, { id: wd.id })
        .execute();
      if (!(r.affected ?? 0)) return;
      const amt = Number(wd.amount_cents);
      await manager.increment(CreatorBalance, { user_id: wd.user_id }, 'available_cents', amt);
      await manager.increment(CreatorBalance, { user_id: wd.user_id }, 'frozen_cents', -amt);
    });
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

  /**
   * 定时兜底：同步 REVIEWING/PROCESSING 的提现单（终态主要靠回调收口，此查单仅兜底）。
   *
   * 资金安全模型（对齐微信/支付宝/Stripe 做法）：
   *  - 受理成功 ≠ 打款成功；微信明确要求受理≥1分钟才可查单，刚发起即查可能返回"不存在"。
   *  - 404（查无此单）视为"未确认/未知"，绝不等同于"打款失败"。
   *  - 仅微信明确返回 FAIL/CANCELLED（applyTransferState 处理）才安全解冻。
   *  - 404 一律保持观察：累计次数，且单龄≥30min 且连续≥2次才判定为"请求从未受理"。
   *  - REVIEWING 卡住 = 打款请求从未真正发出（如 freeze 后进程崩溃），微信侧永远不会有此单，
   *    达阈值后安全自动解冻退款；PROCESSING 卡住 = 已受理待打款，404 可能为瞬时，绝不自动解冻，转人工。
   */
  private async syncProcessingWithdrawals() {
    const now = Date.now();
    const reviewingCutoff = new Date(now - 5 * 60_000); // REVIEWING 冷却 5min（避免刚发起即误查 404）
    const processingCutoff = new Date(now - 2 * 60_000); // PROCESSING 较早轮询，捕捉漏掉的回调终态
    const stuck = await this.wdRepo.find({
      where: [
        { status: 'PROCESSING', reviewed_at: LessThan(processingCutoff) },
        { status: 'REVIEWING', reviewed_at: LessThan(reviewingCutoff) },
      ],
      take: 20,
    });
    for (const wd of stuck) {
      const ageMin = (now - new Date(wd.reviewed_at!).getTime()) / 60_000;

      // 僵尸单告警：超 24h 仍未收口（如 PROCESSING 长期查单异常），需人工核查资金是否打出。
      // 不解冻、不改态，交由运营在微信商户平台核对后手动处理。
      if (ageMin >= 24 * 60 && !this.zombieAlerted.has(wd.id)) {
        this.zombieAlerted.add(wd.id);
        this.logger.error(`提现单卡在 ${wd.status} 超24h 未收口，需人工核查资金是否打出: ${wd.out_bill_no}`);
      }

      try {
        const q = await this.wechat.queryTransfer(wd.out_bill_no);
        this.notFoundCounts.delete(wd.id); // 拿到真实响应 → 复位 404 计数
        await this.applyTransferState(wd, q);
      } catch (e: any) {
        if (e instanceof WechatApiError && e.wechatStatus === 404) {
          if (wd.status === 'REVIEWING') {
            // REVIEWING = 打款请求从未发出（微信侧永远不会有此单）。
            // 30min 窗口 + 多次确认排除"刚发起查单返回不存在"的瞬时误判 → 安全自动解冻退款。
            const cnt = (this.notFoundCounts.get(wd.id) || 0) + 1;
            this.notFoundCounts.set(wd.id, cnt);
            if (ageMin >= 30 && cnt >= 2) {
              this.logger.error(
                `REVIEWING 提现单长时间无微信转账单(${cnt}次404,${ageMin.toFixed(0)}min)，按未受理自动解冻: ${wd.out_bill_no}`,
              );
              await this.failWithdrawal(wd, '打款未受理（微信长时间无此单），已自动退回余额');
              this.notFoundCounts.delete(wd.id);
            } else {
              this.logger.warn(`微信无此转账单(${cnt}次)，暂保持观察(${ageMin.toFixed(0)}min): ${wd.out_bill_no}`);
            }
          } else {
            // PROCESSING = 已受理待打款，404 极可能为瞬时/异常；绝不解冻，保持观察待人工/回调。
            this.logger.warn(`微信无此转账单(PROCESSING,${ageMin.toFixed(0)}min)，保持观察待人工核查: ${wd.out_bill_no}`);
          }
        } else {
          // 网络/超时/5xx 等不确定错误：复位计数，仅告警，绝不解冻
          this.notFoundCounts.delete(wd.id);
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

    // 期望退款扣回：遍历每个 SUCCESS 退款，按所属订单 item 的分成比例回算应扣创作者的金额。
    // 旧公式 `credited - refundDeduct - (payable - refundDeduct)` 把退款项代数抵消，
    // 等价于 `credited - payable`，退款侧完全未被校验，且 HIGH-2（多次退款漏扣）会被掩盖。
    // 这里显式算出 expectedRefundDeduct，与流水里实际扣回的 refundDeductCents 勾稽。
    const successRefunds = await this.refundRepo.find({ where: { status: 'SUCCESS' } });
    const orderIds = [...new Set(successRefunds.map((r) => r.order_id))];
    const ordersMap = new Map(
      (orderIds.length ? await this.orderRepo.find({ where: { id: In(orderIds) } }) : []).map((o) => [o.id, o]),
    );
    const itemsByOrder = new Map<string, typeof successRefunds>();
    if (orderIds.length) {
      const allItems = await this.itemRepo.find({ where: { order_id: In(orderIds) } });
      for (const it of allItems) {
        const arr = itemsByOrder.get(it.order_id) || [];
        arr.push(it as any);
        itemsByOrder.set(it.order_id, arr);
      }
    }
    let expectedRefundDeduct = 0;
    for (const rf of successRefunds) {
      const o = ordersMap.get(rf.order_id);
      if (!o) continue;
      const paid = Number(o.paid_cents || 0) || 1;
      const ratio = Number(rf.amount_cents) / paid;
      for (const it of itemsByOrder.get(rf.order_id) || []) {
        const income = Number((it as any).seller_income_cents || 0);
        if ((it as any).seller_user_id && income > 0) {
          expectedRefundDeduct += Math.round(income * ratio);
        }
      }
    }
    // 入账流水 - 实际退款扣回 应当等于「已交付订单应付分成 - 期望退款扣回」
    const settlementDiffCents = creditedCents - refundDeductCents - (payableCents - expectedRefundDeduct);

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
        expectedRefundDeductCents: expectedRefundDeduct,
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
