import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { CreatorBalance, BalanceTransaction, Withdrawal } from './payments.entity';
import { SettingsService } from './settings.service';

/** 可提现额度明细 */
export interface WithdrawableInfo {
  /** 账面可用余额 */
  availableCents: number;
  /** 仍处于结算冻结期内的收入（不可提） */
  frozenIncomeCents: number;
  /** 已提交待审、尚未冻结余额的提现单占用（不可重复提） */
  pendingWithdrawCents: number;
  /** 实际可提现额度 */
  withdrawableCents: number;
  /** 结算冻结期（天） */
  settlementDelayDays: number;
  /** 最早一笔冻结中收入的解冻时间，无冻结则为 null */
  nextUnlockAt: string | null;
}

/**
 * 创作者余额。所有增减用 Repository.increment 原子 SQL（UPDATE ... = col + N），
 * 避免并发竞态；不复式流水，永不删改。退款致余额不足允许为负挂账。
 *
 * 结算冻结期：收入立即进 available_cents（保证流水与账面一致），但可提现额度按
 * 「available - 冻结期内收入 - 待审提现占用」实时计算，无需定时任务解冻。
 */
@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(CreatorBalance) private readonly balRepo: Repository<CreatorBalance>,
    @InjectRepository(BalanceTransaction) private readonly txRepo: Repository<BalanceTransaction>,
    @InjectRepository(Withdrawal) private readonly wdRepo: Repository<Withdrawal>,
    private readonly settings: SettingsService,
  ) {}

  /** 确保余额行存在（首次有收入前） */
  private async ensure(user_id: string) {
    await this.balRepo
      .createQueryBuilder()
      .insert()
      .values({ user_id, available_cents: 0, frozen_cents: 0, total_earned_cents: 0, total_withdrawn_cents: 0 })
      .orIgnore()
      .execute();
  }

  /**
   * 入账（收入）。**先原子插入流水、再调整余额**——这是并发安全的关键。
   *
   * 旧实现先把余额 increment 再 insert 流水，唯一索引只能拦住"重复 insert"，
   * 拦不住已经发生的重复 increment：微信回调发货与前端轮询发货并发进入同一订单时，
   * 两路都通过了"先查后插"的非原子判重，各自 increment 一次 → 余额双倍入账（HIGH-1）。
   *
   * 新实现：用 `INSERT ... ON CONFLICT DO NOTHING RETURNING id` 做原子门控（唯一索引
   * (user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL 兜底层）。
   * RETURNING 仅对真正插入的行返回，冲突则为空数组 → 视为幂等成功、**不**调整余额。
   * 只有流水真正落库的那一路才 increment，从根上消除并发双入账。
   *
   * 无 ref_id 的调用（如提现 withdraw 走 completeWithdraw）无法幂等，保留原有直接入账逻辑。
   */
  async credit(user_id: string, amount_cents: number, biz_type: string, ref_id?: string, remark?: string) {
    if (amount_cents <= 0) return;
    await this.ensure(user_id);

    if (!ref_id) {
      await this.balRepo.increment({ user_id }, 'available_cents', amount_cents);
      await this.balRepo.increment({ user_id }, 'total_earned_cents', amount_cents);
      const bal = await this.balRepo.findOne({ where: { user_id } });
      await this.txRepo.insert({
        user_id,
        direction: 'in',
        amount_cents,
        balance_after_cents: bal?.available_cents ?? amount_cents,
        biz_type,
        ref_id,
        remark,
      } as any);
      return;
    }

    const inserted = await this.txRepo.query(
      `INSERT INTO balance_transactions (id, user_id, direction, amount_cents, balance_after_cents, biz_type, ref_id, remark, created_at)
       VALUES (gen_random_uuid(), $1, 'in', $2, 0, $3, $4, $5, NOW())
       ON CONFLICT (user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [user_id, amount_cents, biz_type, ref_id, remark ?? null],
    );
    if (!Array.isArray(inserted) || inserted.length === 0) {
      this.logger.log(`credit 幂等跳过（已入账 ref_id=${ref_id} biz=${biz_type}）`);
      return;
    }

    // 仅当流水真正插入时才调整余额——并发双调用的另一路走到这里时 inserted 为空，跳过。
    await this.balRepo.increment({ user_id }, 'available_cents', amount_cents);
    await this.balRepo.increment({ user_id }, 'total_earned_cents', amount_cents);
    const bal = await this.balRepo.findOne({ where: { user_id } });
    await this.txRepo.update(
      { user_id, ref_id, biz_type, direction: 'in' } as any,
      { balance_after_cents: bal?.available_cents ?? amount_cents },
    );
  }

  /** 提现：冻结（available → frozen） */
  async freeze(user_id: string, amount_cents: number) {
    const bal = await this.balRepo.findOne({ where: { user_id } });
    if (!bal || bal.available_cents < amount_cents) {
      throw new BadRequestException('余额不足');
    }
    await this.balRepo.increment({ user_id }, 'available_cents', -amount_cents);
    await this.balRepo.increment({ user_id }, 'frozen_cents', amount_cents);
  }

  /** 提现成功：冻结释放并计入已提现 */
  async completeWithdraw(user_id: string, amount_cents: number) {
    await this.balRepo.increment({ user_id }, 'frozen_cents', -amount_cents);
    await this.balRepo.increment({ user_id }, 'total_withdrawn_cents', amount_cents);
    const bal = await this.balRepo.findOne({ where: { user_id } });
    await this.txRepo.insert({
      user_id,
      direction: 'out',
      amount_cents,
      balance_after_cents: bal?.available_cents ?? 0,
      biz_type: 'withdraw',
    } as any);
  }

  /** 提现失败：解冻回可用 */
  async unfreeze(user_id: string, amount_cents: number) {
    await this.balRepo.increment({ user_id }, 'available_cents', amount_cents);
    await this.balRepo.increment({ user_id }, 'frozen_cents', -amount_cents);
  }

  /**
   * 退款扣减（可能为负挂账）。与 credit 同源的原子门控：先 INSERT ... ON CONFLICT DO NOTHING
   * RETURNING，仅真正插入的那一路才 decrement 余额。
   *
   * 注意调用方必须把 ref_id 传**退款单 id**（而非订单 id）——同一订单的多次部分退款
   * 才能各自拿到独立幂等键，否则第二次起的扣回会被唯一索引吞掉 → 创作者少扣（HIGH-2）。
   */
  async debitForRefund(user_id: string, amount_cents: number, ref_id?: string) {
    await this.ensure(user_id);

    if (!ref_id) {
      await this.balRepo.increment({ user_id }, 'available_cents', -amount_cents);
      await this.balRepo.increment({ user_id }, 'total_earned_cents', -amount_cents);
      const bal = await this.balRepo.findOne({ where: { user_id } });
      await this.txRepo.insert({
        user_id,
        direction: 'out',
        amount_cents,
        balance_after_cents: bal?.available_cents ?? -amount_cents,
        biz_type: 'refund_deduct',
        ref_id,
      } as any);
      return;
    }

    const inserted = await this.txRepo.query(
      `INSERT INTO balance_transactions (id, user_id, direction, amount_cents, balance_after_cents, biz_type, ref_id, created_at)
       VALUES (gen_random_uuid(), $1, 'out', $2, 0, 'refund_deduct', $3, NOW())
       ON CONFLICT (user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [user_id, amount_cents, ref_id],
    );
    if (!Array.isArray(inserted) || inserted.length === 0) {
      this.logger.log(`debitForRefund 幂等跳过（已扣回 ref_id=${ref_id}）`);
      return;
    }

    await this.balRepo.increment({ user_id }, 'available_cents', -amount_cents);
    await this.balRepo.increment({ user_id }, 'total_earned_cents', -amount_cents);
    const bal = await this.balRepo.findOne({ where: { user_id } });
    await this.txRepo.update(
      { user_id, ref_id, biz_type: 'refund_deduct', direction: 'out' } as any,
      { balance_after_cents: bal?.available_cents ?? -amount_cents },
    );
  }

  /* ============ 可提现额度（结算冻结期，无定时任务） ============ */

  /**
   * 仍在结算冻结期内的收入合计。
   * 退款走 direction='out' 不在此统计内，因此该值只会偏大 → 额度只会偏保守，方向安全。
   */
  async getFrozenIncomeCents(user_id: string, delayDays: number): Promise<number> {
    if (!delayDays || delayDays <= 0) return 0;
    const since = new Date(Date.now() - delayDays * 86_400_000);
    const row = await this.txRepo
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.amount_cents), 0)', 'sum')
      .where('t.user_id = :uid', { uid: user_id })
      .andWhere("t.direction = 'in'")
      .andWhere('t.created_at > :since', { since })
      .getRawOne<{ sum: string }>();
    return Number(row?.sum || 0);
  }

  /**
   * 待审提现单占用。PENDING 状态尚未 freeze 余额，若不扣除，
   * 创作者可重复提交多张单据把同一笔钱提走多次。
   * REVIEWING 已经 freeze（available 已减），不重复计算。
   */
  async getPendingWithdrawCents(user_id: string): Promise<number> {
    const row = await this.wdRepo
      .createQueryBuilder('w')
      .select('COALESCE(SUM(w.amount_cents), 0)', 'sum')
      .where('w.user_id = :uid', { uid: user_id })
      .andWhere("w.status = 'PENDING'")
      .getRawOne<{ sum: string }>();
    return Number(row?.sum || 0);
  }

  /** 可提现额度明细。任一查询异常时降级为「不可提现」（出账不可逆，宁可拦住） */
  async getWithdrawableInfo(user_id: string): Promise<WithdrawableInfo> {
    const settlementDelayDays = await this.settings.getSettlementDelayDays();
    try {
      const bal = await this.balRepo.findOne({ where: { user_id } });
      const availableCents = Number(bal?.available_cents || 0);
      const [frozenIncomeCents, pendingWithdrawCents] = await Promise.all([
        this.getFrozenIncomeCents(user_id, settlementDelayDays),
        this.getPendingWithdrawCents(user_id),
      ]);
      const withdrawableCents = Math.max(0, availableCents - frozenIncomeCents - pendingWithdrawCents);

      let nextUnlockAt: string | null = null;
      if (frozenIncomeCents > 0 && settlementDelayDays > 0) {
        const since = new Date(Date.now() - settlementDelayDays * 86_400_000);
        const oldest = await this.txRepo.findOne({
          where: { user_id, direction: 'in', created_at: MoreThan(since) } as any,
          order: { created_at: 'ASC' },
        });
        if (oldest?.created_at) {
          nextUnlockAt = new Date(
            new Date(oldest.created_at).getTime() + settlementDelayDays * 86_400_000,
          ).toISOString();
        }
      }

      return {
        availableCents,
        frozenIncomeCents,
        pendingWithdrawCents,
        withdrawableCents,
        settlementDelayDays,
        nextUnlockAt,
      };
    } catch (e) {
      this.logger.warn(`可提现额度计算失败，降级为不可提现: ${(e as Error)?.message}`);
      return {
        availableCents: 0,
        frozenIncomeCents: 0,
        pendingWithdrawCents: 0,
        withdrawableCents: 0,
        settlementDelayDays,
        nextUnlockAt: null,
      };
    }
  }
}
