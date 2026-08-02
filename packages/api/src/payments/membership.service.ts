import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThanOrEqual } from 'typeorm';
import { Membership, MembershipDownload, OrderItem, Settlement } from './payments.entity';
import { BalanceService } from './balance.service';
import { EntitlementService } from './entitlement.service';
import { SettingsService } from './settings.service';

/**
 * 会员订阅 + 用户中心制收益池分配。
 * 用户中心制：每个会员的月费扣抽成后，均分给其本月去重下载的技能作者（上限 30）。
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectRepository(Membership) private readonly memberRepo: Repository<Membership>,
    @InjectRepository(MembershipDownload) private readonly dlRepo: Repository<MembershipDownload>,
    @InjectRepository(OrderItem) private readonly itemRepo: Repository<OrderItem>,
    @InjectRepository(Settlement) private readonly settleRepo: Repository<Settlement>,
    private readonly balance: BalanceService,
    private readonly entitlement: EntitlementService,
    private readonly settings: SettingsService,
  ) {}

  private durationDays(plan: string): number {
    return plan === 'yearly' ? 365 : plan === 'quarterly' ? 90 : 30;
  }

  async activate(userId: string, plan: string, orderId: string): Promise<Membership> {
    const existing = await this.memberRepo.findOne({
      where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
    });
    const base = existing ? new Date(existing.expires_at) : new Date();
    const expires = new Date(base.getTime() + this.durationDays(plan) * 86400_000);
    if (existing) {
      existing.expires_at = expires;
      existing.plan = plan;
      existing.order_id = orderId;
      return this.memberRepo.save(existing);
    }
    return this.memberRepo.save(
      this.memberRepo.create({ user_id: userId, plan, status: 'active', expires_at: expires, order_id: orderId }),
    );
  }

  async isActive(userId: string): Promise<boolean> {
    const m = await this.memberRepo.findOne({
      where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
    });
    return !!m;
  }

  async getMy(userId: string): Promise<Membership | null> {
    return this.memberRepo.findOne({
      where: { user_id: userId },
      order: { started_at: 'DESC' },
    });
  }

  /** 运行某月收益池分配（管理员手动触发；生产可接定时任务） */
  async allocatePool(period: string): Promise<Settlement> {
    const [y, m] = period.split('-').map(Number);
    const periodStart = new Date(y, m - 1, 1);
    const periodEnd = new Date(y, m, 1);

    const members = await this.memberRepo
      .createQueryBuilder('m')
      .where('m.status = :s', { s: 'active' })
      .andWhere('m.started_at <= :end', { end: periodEnd })
      .andWhere('m.expires_at > :start', { start: periodStart })
      .getMany();

    let totalPool = 0;
    let totalCreator = 0;
    let totalPlatform = 0;

    for (const mem of members) {
      const item = await this.itemRepo.findOne({
        where: { order_id: mem.order_id, subject_type: 'membership' },
      });
      const poolShare = item ? Number(item.seller_income_cents) : 0;
      if (poolShare <= 0) continue;
      totalPool += poolShare;

      const downloads = await this.dlRepo
        .createQueryBuilder('d')
        .where('d.user_id = :uid', { uid: mem.user_id })
        .andWhere('d.period = :p', { p: period })
        .andWhere('d.counted = false')
        .getMany();

      const sellers = Array.from(
        new Set(downloads.map((d) => d.seller_user_id).filter((s): s is string => !!s)),
      ).slice(0, 30); // 单会员单周期有效下载上限 30

      if (sellers.length === 0) {
        totalPlatform += poolShare; // 未分配池归平台
        continue;
      }

      const per = Math.floor(poolShare / sellers.length);
      for (const sid of sellers) {
        await this.balance.credit(sid, per, 'membership_share', mem.id, `会员收益池 ${period}`);
        totalCreator += per;
      }
      totalPlatform += poolShare - per * sellers.length; // 余数归平台
      await this.dlRepo.update({ user_id: mem.user_id, period }, { counted: true });
    }

    const settlement = this.settleRepo.create({
      period,
      type: 'membership_pool',
      total_cents: totalPool,
      platform_cents: totalPlatform,
      creator_cents: totalCreator,
      status: 'EXECUTED',
      executed_at: new Date(),
    });
    return this.settleRepo.save(settlement);
  }
}
