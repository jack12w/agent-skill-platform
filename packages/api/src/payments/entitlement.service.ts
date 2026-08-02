import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import { SkillPricing, Entitlement, Membership } from './payments.entity';
import { Skill } from '../skills/skill.entity';
import { PaymentRequiredException } from './payment-exceptions';
import { SettingsService } from './settings.service';
import { MembershipService } from './membership.service';

/**
 * 权益校验 —— 付费墙在 skills.service.ts getDownloadUrl() 的唯一收敛点调用。
 * 放行条件（任一满足）：免费 / 管理员 / 作者本人 / 已购权益有效 /
 *   有效创作者会员（订阅了该技能所属 user/team）且技能会员可下 / 过渡期老全局会员。
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    @InjectRepository(SkillPricing) private readonly pricingRepo: Repository<SkillPricing>,
    @InjectRepository(Entitlement) private readonly entRepo: Repository<Entitlement>,
    @InjectRepository(Membership) private readonly memberRepo: Repository<Membership>,
    private readonly settings: SettingsService,
    private readonly membership: MembershipService,
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

      // 5. 会员可下：过渡期老全局会员 或 已订阅该技能所属创作者
      if (pricing.member_included) {
        const legacy = await this.memberRepo.findOne({
          where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
        });
        if (legacy) return;

        // 技能归属：team 优先，否则 user
        const targetType = skill.owner_team_id ? 'team' : 'user';
        const targetId = skill.owner_team_id || skill.owner_user_id;
        if (targetId && (await this.membership.isSubscribed(userId, targetType, targetId))) {
          return;
        }
      }
    }

    // 未授权 → 抛 402 + 定价信息，前端据此唤起收银台
    const membershipPrices = await this.settings.getMembershipPrices();
    throw new PaymentRequiredException({
      skill_id: skill.id,
      pricing_mode: pricing.pricing_mode,
      price_cents: pricing.price_cents,
      member_included: pricing.member_included,
      // 创作者会员场景下，详情页用以下信息引导用户订阅作者
      owner: {
        target_type: skill.owner_team_id ? 'team' : 'user',
        target_id: skill.owner_team_id || skill.owner_user_id,
      },
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
}
