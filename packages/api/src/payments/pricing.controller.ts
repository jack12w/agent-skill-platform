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
import { SettingsService } from './settings.service';
import { AuthGuard } from '../auth/auth.guard';

const ALLOWED_MODES = ['free', 'paid', 'member_only', 'both'] as const;
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
    const isManager = skill.owner_user_id === uid
      || (!!skill.owner_team_id && !!(await this.teamMemberRepo.findOne({ where: { team_id: skill.owner_team_id, user_id: uid } })));
    if (!isManager && !isAdmin) {
      throw new ForbiddenException('Only the skill owner, a team member, or an admin can set its pricing');
    }

    const mode = body?.pricing_mode as PricingMode;
    if (!ALLOWED_MODES.includes(mode)) {
      throw new BadRequestException(
        `Invalid pricing_mode. Must be one of: ${ALLOWED_MODES.join(', ')}`,
      );
    }

    const priceCents = Math.max(0, Math.round(Number(body?.price_cents) || 0));
    const commercialCents = Math.max(0, Math.round(Number(body?.commercial_price_cents) || 0));
    // 会员专属 / 付费+会员：会员必然包含；付费模式由创作者勾选决定
    const memberIncluded =
      mode === 'member_only' || mode === 'both' ? true : Boolean(body?.member_included);

    /*
     * 单卖价下限校验。
     * 之前只做 Math.max(0, …) 不校验下限，允许存下 pricing_mode='paid' 且 price_cents=0：
     * 付费墙会照常拦截下载（402），但下单时金额为 0 会被微信直接拒绝（最低 1 分），
     * 技能就此陷入「下载不了也买不了」的死锁。member_only 不走单卖，价格恒为 0。
     */
    const MIN_SELL_CENTS = 100; // ¥1，低于此额抽成取整为 0 且不具商业意义
    const sellable = mode === 'paid' || mode === 'both';
    if (sellable && priceCents < MIN_SELL_CENTS) {
      throw new BadRequestException(
        `单独售卖价不能低于 ${MIN_SELL_CENTS / 100} 元。若不想单独售卖，请选择「仅会员可下载」模式。`,
      );
    }
    if (sellable && commercialCents > 0 && commercialCents < MIN_SELL_CENTS) {
      throw new BadRequestException(`商用授权价不能低于 ${MIN_SELL_CENTS / 100} 元`);
    }

    /*
     * 会员依赖模式防呆：member_only / both 依赖创作者会员套餐，
     * 若未设置套餐则用户无法订阅 → 技能变死路（无人可下载）。
     * 此处强制校验，引导创作者先去交易设置配置会员价。
     */
    if (mode === 'member_only' || mode === 'both') {
      const targetType = skill.owner_team_id ? 'team' : 'user';
      const targetId = skill.owner_team_id || skill.owner_user_id;
      if (targetId) {
        const plan = await this.planRepo.findOne({
          where: { target_type: targetType, target_id: targetId },
        });
        if (!plan) {
          throw new BadRequestException(
            '尚未设置会员套餐，无法使用「会员专属」或「付费+会员免费」模式。请先在交易设置中配置会员定价。',
          );
        }
      }
    }

    const pricing = this.pricingRepo.create({
      skill_id: skillId,
      pricing_mode: mode,
      // member_only 不单卖，价格一律归零，避免残留旧价被误当作可购买
      price_cents: sellable ? priceCents : 0,
      member_included: memberIncluded,
      commercial_price_cents: sellable ? commercialCents : 0,
      currency: 'CNY',
    });

    const saved = await this.pricingRepo.save(pricing);
    return { pricing: saved };
  }
}
