import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThanOrEqual } from 'typeorm';
import { Membership, CreatorSubscription } from './payments.entity';
import { BalanceService } from './balance.service';
import { SettingsService } from './settings.service';

/**
 * 创作者会员制（替代原"全平台会员 + 收益池均分"）。
 *
 * - 用户订阅某个创作者（user/team）后，订阅期内可免费下载 TA 的全部技能（含更新）。
 * - 订阅费在支付回调里直接记入创作者余额（扣平台抽成），不再做"月底均分给 ≤30 个创作者"。
 * - 老的全局 memberships 仅作为过渡期访问凭证（已在迁移里免费续 1 个月），不再参与任何分成。
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    @InjectRepository(Membership) private readonly memberRepo: Repository<Membership>,
    @InjectRepository(CreatorSubscription) private readonly csRepo: Repository<CreatorSubscription>,
    private readonly balance: BalanceService,
    private readonly settings: SettingsService,
  ) {}

  private durationDays(plan: string): number {
    return plan === 'yearly' ? 365 : plan === 'quarterly' ? 90 : 30;
  }

  // ───────────────────────── 过渡期：老全局会员 ─────────────────────────

  /** 老全局会员是否仍有效（过渡期免费访问用） */
  async isLegacyActive(userId: string): Promise<boolean> {
    const m = await this.memberRepo.findOne({
      where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
    });
    return !!m;
  }

  /** 老全局会员激活（过渡期仍保留的购买入口用；不再参与收益池） */
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

  async getMyLegacy(userId: string): Promise<Membership | null> {
    return this.memberRepo.findOne({ where: { user_id: userId }, order: { started_at: 'DESC' } });
  }

  // ───────────────────────── 创作者会员订阅 ─────────────────────────

  /** 是否已订阅某创作者（有效期内） */
  async isSubscribed(userId: string, targetType: string, targetId: string): Promise<boolean> {
    if (!userId) return false;
    const sub = await this.csRepo.findOne({
      where: { user_id: userId, target_type: targetType, target_id: targetId, status: 'active', expires_at: MoreThan(new Date()) },
    });
    return !!sub;
  }

  /** 激活/续费一个创作者会员订阅（幂等 upsert；已有效则顺延到期时间） */
  async activateCreatorSub(
    userId: string,
    targetType: string,
    targetId: string,
    plan: string,
    priceCents: number,
    orderId: string,
  ): Promise<CreatorSubscription> {
    // 按唯一键 (user_id, target_type, target_id) 定位同一行，忽略 status / expires_at：
    // 否则订阅过期后（status 仍为 active、仅 expires_at 已过）再次订阅会因找不到有效行
    // 而走 INSERT 分支，撞全局唯一索引 → 500。过期后续订应复位为 active 并从今天顺延。
    // 续费基准取 max(到期日, 现在)：有效期内续费顺延；过期后续订从今天起算，避免得到比现在更早的过期时间。
    const base = new Date();
    const expires = new Date(base.getTime() + this.durationDays(plan) * 86400_000);
    // 并发安全（LOW-3）：两个请求对同一 (user,target) 首次订阅时都可能 findOne 未命中而走 INSERT，
    // 撞全局唯一索引 → 第二路报 23505。捕获后重试走 update 分支即可自愈。
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.csRepo.findOne({
        where: { user_id: userId, target_type: targetType, target_id: targetId },
      });
      if (existing) {
        const ref =
          new Date(existing.expires_at).getTime() > Date.now() ? new Date(existing.expires_at) : new Date();
        const newExpires = new Date(new Date(ref).getTime() + this.durationDays(plan) * 86400_000);
        existing.status = 'active'; // 过期后重订阅复位
        existing.expires_at = newExpires;
        existing.plan = plan;
        existing.price_cents = priceCents;
        existing.order_id = orderId;
        return this.csRepo.save(existing);
      }
      const created = this.csRepo.create({
        user_id: userId,
        target_type: targetType,
        target_id: targetId,
        plan,
        price_cents: priceCents,
        status: 'active',
        expires_at: expires,
        order_id: orderId,
      });
      try {
        return await this.csRepo.save(created);
      } catch (e: any) {
        if (e?.code === '23505' && attempt < 2) {
          this.logger.warn(`activateCreatorSub 并发插入冲突，重试 update 分支: ${userId}/${targetType}/${targetId}`);
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException('订阅激活重试失败，请稍后再试');
  }

  /** 我的全部有效创作者会员订阅 */
  async getMySubs(userId: string): Promise<CreatorSubscription[]> {
    return this.csRepo.find({
      where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
      order: { expires_at: 'ASC' },
    });
  }

  /** 某创作者的有效订阅数（用于主页"X人订阅"） */
  async subscriberCount(targetType: string, targetId: string): Promise<number> {
    return this.csRepo.count({
      where: { target_type: targetType, target_id: targetId, status: 'active', expires_at: MoreThan(new Date()) },
    });
  }

  /** 标记过期订阅（定时任务可选调用；查询时已用 expires_at 过滤，非必需） */
  async expireOverdue(): Promise<number> {
    const overdue = await this.csRepo.find({
      where: { status: 'active', expires_at: LessThanOrEqual(new Date()) },
    });
    for (const s of overdue) {
      s.status = 'expired';
      await this.csRepo.save(s);
    }
    return overdue.length;
  }
}
