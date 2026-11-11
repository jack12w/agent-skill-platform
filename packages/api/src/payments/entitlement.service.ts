import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { SkillPricing, Entitlement, Membership, CreatorMembershipPlan } from './payments.entity';
import { Skill } from '../skills/skill.entity';
import { TeamMember } from '../teams/team-member.entity';
import { MemberRole } from '@platform/shared';
import { PaymentRequiredException, TeamSubscriptionRequiredException } from './payment-exceptions';
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
    @InjectRepository(CreatorMembershipPlan) private readonly planRepo: Repository<CreatorMembershipPlan>,
    private readonly settings: SettingsService,
    private readonly membership: MembershipService,
  ) {}

  /**
   * 团队成员是否拥有管理者权限：OWNER / MAINTAINER，**不含只读的 VIEWER**。
   * 口径同 teams.service.ts 的 assertManager 与 skills.service.ts 的 isTeamManager。
   */
  private async isTeamManager(teamId: string, userId: string): Promise<boolean> {
    const m = await this.teamMemberRepo.findOne({ where: { team_id: teamId, user_id: userId } });
    return !!m && (m.role === MemberRole.OWNER || m.role === MemberRole.MAINTAINER);
  }

  /**
   * 团队订阅墙（0047）—— 团队技能下载的唯一判定入口。
   *
   * 规则（产品定案）：
   *   个人技能                      → 返回 false，完全交回原有逐技能定价逻辑（零影响）
   *   无套餐                        → 全免费（团队技能一律不单卖）
   *   已「立即释放」                → 全免费
   *   停售且已无任何有效订阅         → 自动全免费（最后一个订阅到期即开放）
   *   有墙                          → admin / 团队 owner,maintainer / 有效付费订阅 /
   *                                   历史买断 放行；其余 402 TEAM_SUBSCRIPTION_REQUIRED
   *
   * 返回 true 表示本方法已完成判定（放行或抛错），调用方必须立即 return。
   * 单条 SQL 拿全状态，避免培训现场并发把 DB 打爆；DB 异常一律 500（三态铁律），
   * 绝不当作「未订阅」抛 402，避免已付费用户被误判、重复付款。
   */
  private async assertTeamSkillAccess(
    skill: Skill,
    userId?: string,
    isAdmin = false,
  ): Promise<boolean> {
    if (!skill.owner_team_id) return false;
    const teamId = skill.owner_team_id;

    let rows: any[];
    try {
      rows = await this.planRepo.manager.query(
        `SELECT p.enabled, p.released_at,
                p.monthly_cents, p.quarterly_cents, p.yearly_cents,
                EXISTS (
                  SELECT 1 FROM creator_subscriptions cs
                   WHERE cs.target_type = 'team' AND cs.target_id = $1
                     AND cs.status = 'active' AND cs.expires_at > now()
                ) AS any_active,
                EXISTS (
                  SELECT 1 FROM creator_subscriptions cs
                   WHERE cs.target_type = 'team' AND cs.target_id = $1 AND cs.user_id = $2
                     AND cs.status = 'active' AND cs.expires_at > now()
                ) AS viewer_subscribed,
                EXISTS (
                  SELECT 1 FROM team_members tm
                   WHERE tm.team_id = $1 AND tm.user_id = $2
                     AND tm.role IN ('owner', 'maintainer')
                ) AS viewer_manager,
                EXISTS (
                  SELECT 1 FROM entitlements e
                   WHERE e.user_id = $2 AND e.skill_id = $3
                     AND (e.expires_at IS NULL OR e.expires_at > now())
                ) AS viewer_owned
           FROM creator_membership_plans p
          WHERE p.target_type = 'team' AND p.target_id = $1
          LIMIT 1`,
        [teamId, userId || null, skill.id],
      );
    } catch (e: any) {
      // 三态铁律：DB 异常是「不确定」，不是「无权益」。绝不能放行，也不能 402。
      this.logger.error(`团队订阅墙查询失败 skill=${skill.id} team=${teamId}: ${e?.message || e}`);
      throw new InternalServerErrorException('权益校验暂不可用，请稍后重试');
    }

    const plan = rows?.[0];
    if (!plan) return true;                                  // 无套餐 → 免费，且绝不读 skill_pricing
    if (plan.released_at) return true;                        // 团长立即释放 → 免费
    if (plan.enabled === false && !plan.any_active) return true;  // 停售且最后一个订阅已到期 → 自动免费

    if (isAdmin) return true;
    if (userId && plan.viewer_manager) return true;            // owner / maintainer 管理侧特权
    if (userId && plan.viewer_subscribed) return true;         // 唯一解锁依据：有效付费订阅
    if (userId && plan.viewer_owned) return true;              // 历史买断是永久权益，不能被订阅墙收回

    throw new TeamSubscriptionRequiredException({
      team_id: teamId,
      enabled: plan.enabled !== false,
      plans: {
        monthly: Number(plan.monthly_cents) || 0,
        quarterly: Number(plan.quarterly_cents) || 0,
        yearly: Number(plan.yearly_cents) || 0,
      },
    });
  }

  /**
   * 详情页用的团队套餐视图（0047）。必须 per-request 实时查，绝不进 getSkillCoreCached
   * （那个缓存 10s 且含 hasPlan，套餐停售/释放后会出现 UI 与门禁不一致）。
   * 仅用于展示，真正的下载判定仍以 assertTeamSkillAccess 为准；DB 异常返回
   * unavailable=true（三态铁律），前端显示「状态暂不可用，请重试」而非「免费下载」。
   */
  async getTeamPlanView(teamId: string, userId?: string) {
    const empty = {
      hasPlan: false, enabled: false, released: false, wallActive: false,
      subscribed: false, unavailable: false,
    };
    try {
      const rows: any[] = await this.planRepo.manager.query(
        `SELECT p.enabled, p.released_at,
                EXISTS (
                  SELECT 1 FROM creator_subscriptions cs
                   WHERE cs.target_type = 'team' AND cs.target_id = $1
                     AND cs.status = 'active' AND cs.expires_at > now()
                ) AS any_active,
                EXISTS (
                  SELECT 1 FROM creator_subscriptions cs
                   WHERE cs.target_type = 'team' AND cs.target_id = $1 AND cs.user_id = $2
                     AND cs.status = 'active' AND cs.expires_at > now()
                ) AS viewer_subscribed
           FROM creator_membership_plans p
          WHERE p.target_type = 'team' AND p.target_id = $1
          LIMIT 1`,
        [teamId, userId || null],
      );
      const plan = rows?.[0];
      if (!plan) return empty;
      const enabled = plan.enabled !== false;
      const released = !!plan.released_at;
      return {
        hasPlan: true,
        enabled,
        released,
        wallActive: !released && (enabled || !!plan.any_active),
        subscribed: !!plan.viewer_subscribed,
        unavailable: false,
      };
    } catch (e: any) {
      this.logger.warn(`团队套餐视图查询失败 team=${teamId}: ${e?.message || e}`);
      // 三态铁律：DB 异常是「不确定」，绝不能降级成「无套餐 → 免费」，
      // 否则详情页会显示「免费下载」而点击却是 500。wallActive=true 让前端显示
      // 「状态暂不可用，请重试」，同时后端下载门禁仍由 assertTeamSkillAccess 独立 fail-closed。
      return { ...empty, unavailable: true, wallActive: true };
    }
  }

  async assertCanDownload(skill: Skill, userId?: string, isAdmin = false): Promise<void> {
    // 0047 团队订阅墙：团队技能完全由订阅墙判定，不再读 skill_pricing / member_included。
    if (await this.assertTeamSkillAccess(skill, userId, isAdmin)) return;

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

    // 3. 作者本人 或 团队的 OWNER/MAINTAINER（团队技能 owner_user_id 为 null）。
    //    只认 OWNER/MAINTAINER、不含只读的 VIEWER —— 这里放行等于**绕过付费墙**，
    //    若把只读成员也算作归属者，任何被加为 viewer 的人都能免付下载团队的付费技能。
    //    口径与 teams.service.ts 的 assertManager、skills.service.ts 的 isTeamManager 一致。
    if (userId && (skill.owner_user_id === userId || (!!skill.owner_team_id && (await this.isTeamManager(skill.owner_team_id, userId))))) {
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
