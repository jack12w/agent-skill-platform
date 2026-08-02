import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import { SkillPricing, Entitlement, Membership, MembershipDownload, Order } from './payments.entity';
import { Skill } from '../skills/skill.entity';
import { PaymentRequiredException } from './payment-exceptions';
import { SettingsService } from './settings.service';

/**
 * 权益校验 —— 付费墙在 skills.service.ts getDownloadUrl() 的唯一收敛点调用。
 * 放行条件（任一满足）：免费 / 管理员 / 作者本人 / 已购权益有效 / 有效会员且技能会员可下。
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    @InjectRepository(SkillPricing) private readonly pricingRepo: Repository<SkillPricing>,
    @InjectRepository(Entitlement) private readonly entRepo: Repository<Entitlement>,
    @InjectRepository(Membership) private readonly memberRepo: Repository<Membership>,
    @InjectRepository(MembershipDownload) private readonly dlRepo: Repository<MembershipDownload>,
    private readonly settings: SettingsService,
  ) {}

  async assertCanDownload(skill: Skill, userId?: string, isAdmin = false): Promise<void> {
    let pricing: SkillPricing | null = null;
    try {
      pricing = await this.pricingRepo.findOne({ where: { skill_id: skill.id } });
    } catch (e: any) {
      // 降级放行：0010 迁移未执行（skill_pricing 表不存在）或数据库异常时，
      // 绝不能因为新增的付费墙而阻断原有的免费下载能力。
      this.logger.warn(`定价查询失败，按免费放行 skill=${skill.id}: ${e?.message}`);
      return;
    }

    // 1. 免费 / 无定价
    if (!pricing || pricing.pricing_mode === 'free') return;

    // 2. 管理员
    if (isAdmin) return;

    // 3. 作者本人
    if (userId && skill.owner_user_id === userId) return;

    if (userId) {
      // 4. 已购有效权益（含永久 expires_at IS NULL）
      const owned = await this.entRepo
        .createQueryBuilder('e')
        .where('e.user_id = :uid', { uid: userId })
        .andWhere('e.skill_id = :sid', { sid: skill.id })
        .andWhere('(e.expires_at IS NULL OR e.expires_at > :now)', { now: new Date() })
        .getOne();
      if (owned) return;

      // 5. 有效会员 + 技能会员可下
      if (pricing.member_included) {
        const member = await this.memberRepo.findOne({
          where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
        });
        if (member) {
          await this.recordMembershipDownload(userId, skill.id, skill.owner_user_id);
          return;
        }
      }
    }

    // 未授权 → 抛 402 + 定价信息，前端据此唤起收银台
    const membershipPrices = await this.settings.getMembershipPrices();
    // 字段名与 GET /pay/pricing/:skillId 保持一致（snake_case），前端可直接复用
    throw new PaymentRequiredException({
      skill_id: skill.id,
      pricing_mode: pricing.pricing_mode,
      price_cents: pricing.price_cents,
      member_included: pricing.member_included,
      membership: membershipPrices,
    });
  }

  /** 买断授权：写 entitlements(source=purchase) */
  async grantPurchase(user_id: string, skill_id: string, order_id: string, license = 'personal') {
    await this.entRepo
      .createQueryBuilder()
      .insert()
      .values({ user_id, skill_id, source: 'purchase', license, order_id })
      .orUpdate(['source', 'license', 'order_id', 'granted_at'], ['user_id', 'skill_id', 'license'])
      .execute();
  }

  /** 记录会员下载（收益池去重：同一用户×同一技能×同一周期只记一条） */
  private async recordMembershipDownload(user_id: string, skill_id: string, seller_user_id?: string) {
    const period = this.periodOf(new Date());
    try {
      await this.dlRepo
        .createQueryBuilder()
        .insert()
        .values({ user_id, skill_id, seller_user_id, period, counted: false })
        .orIgnore()
        .execute();
    } catch (e: any) {
      // 统计写入失败不应阻断会员的正常下载，仅告警
      this.logger.warn(`会员下载记录写入失败 user=${user_id} skill=${skill_id}: ${e?.message}`);
    }
  }

  periodOf(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}
