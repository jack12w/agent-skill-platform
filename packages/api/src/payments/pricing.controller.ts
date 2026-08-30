import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Body,
  UseGuards,
  Request,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkillPricing, CreatorMembershipPlan } from './payments.entity';
import { Skill } from '../skills/skill.entity';
import { TeamMember } from '../teams/team-member.entity';
import { MemberRole } from '@platform/shared';
import { SettingsService } from './settings.service';
import { AuthGuard } from '../auth/auth.guard';

const ALLOWED_MODES = ['free', 'paid'] as const;
type PricingMode = (typeof ALLOWED_MODES)[number];

/**
 * 定价接口控制器。
 *
 * 读接口（GET）不加 AuthGuard —— 未登录用户也需要在技能详情页看到价格 / 会员方案。
 * 写接口（PUT）必须加 AuthGuard 并校验技能归属，避免任意用户篡改他人技能价格。
 */
@Controller('pay')
export class PricingController {
  constructor(
    @InjectRepository(SkillPricing) private readonly pricingRepo: Repository<SkillPricing>,
    @InjectRepository(Skill) private readonly skillRepo: Repository<Skill>,
    @InjectRepository(CreatorMembershipPlan) private readonly planRepo: Repository<CreatorMembershipPlan>,
    @InjectRepository(TeamMember) private readonly teamMemberRepo: Repository<TeamMember>,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 团队成员是否拥有管理者权限：OWNER / MAINTAINER，**不含只读的 VIEWER**。
   * 口径同 teams.service.ts 的 assertManager 与 skills.service.ts 的 isTeamManager。
   */
  private async isTeamManager(teamId: string, userId: string): Promise<boolean> {
    const m = await this.teamMemberRepo.findOne({ where: { team_id: teamId, user_id: userId } });
    return !!m && (m.role === MemberRole.OWNER || m.role === MemberRole.MAINTAINER);
  }

  /** 单个技能的定价 + 会员方案价格（公开） */
  @Get('pricing/:skillId')
  async pricing(@Param('skillId') skillId: string) {
    const free = {
      pricing_mode: 'free',
      price_cents: 0,
      member_included: false,
      commercial_price_cents: 0,
      currency: 'CNY',
    };
    try {
      const pricing = await this.pricingRepo.findOne({ where: { skill_id: skillId } });
      const membership = await this.settings.getMembershipPrices();
      return { pricing: pricing || free, membership };
    } catch {
      // 迁移未执行等异常：降级为免费，避免技能详情页因新接口报错
      return {
        pricing: free,
        membership: { monthly: 2900, quarterly: 7900, yearly: 26800 },
      };
    }
  }

  /** 会员方案价格（公开） */
  @Get('membership-prices')
  async membershipPrices() {
    return this.settings.getMembershipPrices();
  }

  /** 公开：当前平台抽成比例（basis point），供订阅协议等公开页引用真实值 */
  @Get('commission')
  async commission() {
    return { commissionRateBp: await this.settings.getCommissionBp() };
  }

  /**
   * 某创作者 / 团队是否设置了付费会员套餐（公开，未登录可读）。
   * 前端据此决定「订阅」按钮行为：无套餐→免费关注（POST /api/subscriptions）；
   * 有套餐→打开付费会员弹窗（须支付成功才订阅成功）。
   */
  @Get('creator-plan')
  async creatorPlan(@Query('targetType') targetType: string, @Query('targetId') targetId: string) {
    if (!targetType || !targetId) throw new BadRequestException('缺少 targetType / targetId');
    const plan = await this.planRepo.findOne({ where: { target_type: targetType, target_id: targetId } });
    const suggested = await this.settings.getMembershipPrices();
    if (!plan) {
      return { hasPlan: false, plans: null, suggested, targetType, targetId };
    }
    return {
      hasPlan: true,
      plans: {
        monthly: Number(plan.monthly_cents) || 0,
        quarterly: Number(plan.quarterly_cents) || 0,
        yearly: Number(plan.yearly_cents) || 0,
      },
      suggested,
      targetType,
      targetId,
    };
  }

  /**
   * 设置技能定价（仅技能作者 / 管理员）。
   * 幂等 upsert：已有定价则更新，没有则插入。
   */
  @UseGuards(AuthGuard)
  @Put('pricing/:skillId')
  async updatePricing(
    @Param('skillId') skillId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const skill = await this.skillRepo.findOne({ where: { id: skillId } });
    if (!skill) throw new NotFoundException('Skill not found');

    const isAdmin = req.user?.role === 'admin';
    const uid = req.user.sub;
    // 团队的 OWNER/MAINTAINER 才可改价；VIEWER 是只读角色，不能定价
    // （口径同 teams.service.ts assertManager / skills.service.ts isTeamManager）
    const isManager =
      skill.owner_user_id === uid ||
      (!!skill.owner_team_id && (await this.isTeamManager(skill.owner_team_id, uid)));
    if (!isManager && !isAdmin) {
      throw new ForbiddenException('Only the skill owner, a team owner/maintainer, or an admin can set its pricing');
    }

    const rawMode = body?.pricing_mode as string;
    // 兼容旧客户端：member_only / both 已废弃，统一归并为 paid。
    // 「会员可免费下载」不再作为独立定价类型，而是由 owner 是否配置会员套餐自动派生。
    const mode: PricingMode =
      rawMode === 'member_only' || rawMode === 'both' ? 'paid' : (rawMode as PricingMode);
    if (!ALLOWED_MODES.includes(mode)) {
      throw new BadRequestException(
        `Invalid pricing_mode. Must be one of: ${ALLOWED_MODES.join(', ')}`,
      );
    }

    const priceCents = Math.max(0, Math.round(Number(body?.price_cents) || 0));
    const commercialCents = Math.max(0, Math.round(Number(body?.commercial_price_cents) || 0));

    /*
     * 会员可免费下载（member_included）自动派生：
     * 付费技能若所属创作者/团队已配置会员套餐 → true（订阅者可免费下）；否则 false（纯单购）。
     * 不再由前端勾选，避免与套餐实际状态脱节；同时由套餐变更接口同步刷新（见 PaymentsController）。
     */
    const targetType = skill.owner_team_id ? 'team' : 'user';
    const targetId = skill.owner_team_id || skill.owner_user_id;
    const hasPlan = targetId
      ? !!(await this.planRepo.findOne({ where: { target_type: targetType, target_id: targetId } }))
      : false;
    const memberIncluded = mode === 'paid' ? hasPlan : false;

    /*
     * 单卖价下限校验：paid 模式下 price_cents 不能低于 ¥1，
     * 否则付费墙拦截下载但下单金额为 0 会被微信拒绝（最低 1 分），技能陷入死锁。
     */
    const MIN_SELL_CENTS = 100; // ¥1
    const sellable = mode === 'paid';
    if (sellable && priceCents < MIN_SELL_CENTS) {
      throw new BadRequestException(`单独售卖价不能低于 ${MIN_SELL_CENTS / 100} 元。`);
    }
    if (sellable && commercialCents > 0 && commercialCents < MIN_SELL_CENTS) {
      throw new BadRequestException(`商用授权价不能低于 ${MIN_SELL_CENTS / 100} 元`);
    }

    const pricing = this.pricingRepo.create({
      skill_id: skillId,
      pricing_mode: mode,
      price_cents: sellable ? priceCents : 0,
      member_included: memberIncluded,
      commercial_price_cents: sellable ? commercialCents : 0,
      currency: 'CNY',
    });

    const saved = await this.pricingRepo.save(pricing);
    return { pricing: saved };
  }
}
