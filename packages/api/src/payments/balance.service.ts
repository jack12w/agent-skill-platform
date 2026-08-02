import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreatorBalance, BalanceTransaction } from './payments.entity';

/**
 * 创作者余额。所有增减用 Repository.increment 原子 SQL（UPDATE ... = col + N），
 * 避免并发竞态；不复式流水，永不删改。退款致余额不足允许为负挂账。
 */
@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(CreatorBalance) private readonly balRepo: Repository<CreatorBalance>,
    @InjectRepository(BalanceTransaction) private readonly txRepo: Repository<BalanceTransaction>,
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

  /** 入账（收入） */
  async credit(user_id: string, amount_cents: number, biz_type: string, ref_id?: string, remark?: string) {
    if (amount_cents <= 0) return;
    await this.ensure(user_id);
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

  /** 退款扣减（可能为负挂账） */
  async debitForRefund(user_id: string, amount_cents: number, ref_id?: string) {
    await this.ensure(user_id);
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
  }
}
