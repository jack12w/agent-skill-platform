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
      .values({ user_id, available_cents: 0, frozen_cents: 0, total_earned_cents: 0, total_withdrawn_cents: 0, version: 0 })
      .orIgnore()
      .execute();
  }

  /** 入账（收入）。按 (ref_id, biz_type, direction=in) 幂等：重复调用只入账一次。 */
  async credit(user_id: string, amount_cents: number, biz_type: string, ref_id?: string, remark?: string) {
    if (amount_cents <= 0) return;
    if (ref_id) {
      const dup = await this.txRepo.findOne({ where: { ref_id, biz_type, direction: 'in' } as any });
      if (dup) {
        this.logger.log(`credit 幂等跳过（已入账 ref_id=${ref_id} biz=${biz_type}）`);
        return;
      }
    }
    await this.ensure(user_id);
    await this.balRepo.increment({ user_id }, 'available_cents', amount_cents);
    await this.balRepo.increment({ user_id }, 'total_earned_cents', amount_cents);
    const bal = await this.balRepo.findOne({ where: { user_id } });
    try {
      await this.txRepo.insert({
        user_id,
        direction: 'in',
        amount_cents,
        balance_after_cents: bal?.available_cents ?? amount_cents,
        biz_type,
        ref_id,
        remark,
      } as any);
    } catch (e: any) {
      // 并发双插被 0014 唯一索引挡下（pg 23505）：视为幂等成功，跳过。
      if (e?.code === '23505') {
        this.logger.log(`credit 唯一冲突，幂等跳过（ref_id=${ref_id} biz=${biz_type}）`);
        return;
      }
      throw e;
    }
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

  /** 退款扣减（可能为负挂账）。按 (ref_id, biz_type=refund_deduct, direction=out) 幂等。 */
  async debitForRefund(user_id: string, amount_cents: number, ref_id?: string) {
    await this.ensure(user_id);
    if (ref_id) {
      const dup = await this.txRepo.findOne({ where: { ref_id, biz_type: 'refund_deduct', direction: 'out' } as any });
      if (dup) {
        this.logger.log(`debitForRefund 幂等跳过（已扣回 ref_id=${ref_id}）`);
        return;
      }
    }
    await this.balRepo.increment({ user_id }, 'available_cents', -amount_cents);
    await this.balRepo.increment({ user_id }, 'total_earned_cents', -amount_cents);
    const bal = await this.balRepo.findOne({ where: { user_id } });
    try {
      await this.txRepo.insert({
        user_id,
        direction: 'out',
        amount_cents,
        balance_after_cents: bal?.available_cents ?? -amount_cents,
        biz_type: 'refund_deduct',
        ref_id,
      } as any);
    } catch (e: any) {
      if (e?.code === '23505') {
        this.logger.log(`debitForRefund 唯一冲突，幂等跳过（ref_id=${ref_id}）`);
        return;
      }
      throw e;
    }
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
