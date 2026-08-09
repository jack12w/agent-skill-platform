import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import { SkillPricing, Entitlement, Membership } from './payments.entity';
import { Skill } from '../skills/skill.entity';
import { TeamMember } from '../teams/team-member.entity';
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
    @InjectRepository(TeamMember) private readonly teamMemberRepo: Repository<TeamMember>,
    private readonly settings: SettingsService,
    private readonly membership: MembershipService,
  ) {}

  async assertCanDownload(skill: Skill, userId?: string, isAdmin = false): Promise<void> {
    let pricing: SkillPricing | null = null;
    try {
      pricing = await this.pricingRepo.findOne({ where: { skill_id: skill.id } });
    } catch (e: any) {
      const msg = e?.message || '';
      // 部署期安全：迁移 0010 尚未执行（skill_pricing 表不存在）时，按免费放行，
      // 避免阻断原有的免费下载能力（与 pricing GET 接口的降级保持一致）。
      if (/skill_pricing/i.test(msg) && /does not exist/i.test(msg)) {
        this.logger.warn(`定价表不存在，按免费放行 skill=${skill.id}: ${msg}`);
        return;
      }
      // 运行时数据库异常：绝不能放行付费内容。改为 fail-closed 让调用方重试，
      // 避免 DB 抖动期间付费技能被白嫖（原实现为 fail-open，等于任意付费技能可免费下载）。
      this.logger.error(`定价查询失败，fail-closed 拒绝下载 skill=${skill.id}: ${msg}`);
      throw new InternalServerErrorException('资源暂不可用，请稍后重试');
    }

    // 1. 免费 / 无定价
    if (!pricing || pricing.pricing_mode === 'free') {
      return;
    }

    // 2. 管理员
    if (isAdmin) {
      return;
    }

    // 3. 作者本人 或 所属团队成员（团队技能 owner_user_id 为 null，按团队成员放行，避免团队自己付费下载）
    if (userId && (skill.owner_user_id === userId || (!!skill.owner_team_id && !!(await this.teamMemberRepo.findOne({ where: { team_id: skill.owner_team_id, user_id: userId } }))))) {
      return;
    }

    if (userId) {
      // 4. 已购有效权益（含永久 expires_at IS NULL）
      const owned = await this.entRepo
        .createQueryBuilder('e')
        .where('e.user_id = :uid', { uid: userId })
        .andWhere('e.skill_id = :sid', { sid: skill.id })
        .andWhere('(e.expires_at IS NULL OR e.expires_at > :now)', { now: new Date() })
        .getOne();
      if (owned) {
        return;
      }

      // 5. 会员可下：过渡期老全局会员 或 已订阅该技能所属创作者
      if (pricing.member_included) {
        const legacy = await this.memberRepo.findOne({
          where: { user_id: userId, status: 'active', expires_at: MoreThan(new Date()) },
        });
        if (legacy) {
          return;
        }

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
