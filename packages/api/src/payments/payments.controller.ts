import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  Param,
  Query,
  Req,
  Header,
  UseGuards,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Public } from '../auth/public.decorator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { OrdersService } from './orders.service';
import { MembershipService } from './membership.service';
import { SettingsService } from './settings.service';
import { BalanceService } from './balance.service';
import { CreatorBalance, BalanceTransaction, Withdrawal, CreatorMembershipPlan, CreatorSubscription, SkillPricing } from './payments.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { TeamMember } from '../teams/team-member.entity';
import { MemberRole } from '@platform/shared';
import { Skill } from '../skills/skill.entity';

@Controller('pay')
@UseGuards(AuthGuard)
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);
  constructor(
    private readonly orders: OrdersService,
    private readonly membership: MembershipService,
    private readonly settings: SettingsService,
    private readonly balance: BalanceService,
    @InjectRepository(CreatorBalance) private readonly balRepo: Repository<CreatorBalance>,
    @InjectRepository(BalanceTransaction) private readonly txRepo: Repository<BalanceTransaction>,
    @InjectRepository(Withdrawal) private readonly wdRepo: Repository<Withdrawal>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Team) private readonly teamRepo: Repository<Team>,
    @InjectRepository(TeamMember) private readonly teamMemberRepo: Repository<TeamMember>,
    @InjectRepository(CreatorMembershipPlan) private readonly planRepo: Repository<CreatorMembershipPlan>,
    @InjectRepository(CreatorSubscription) private readonly csRepo: Repository<CreatorSubscription>,
    @InjectRepository(SkillPricing) private readonly skillPricingRepo: Repository<SkillPricing>,
    @InjectRepository(Skill) private readonly skillRepo: Repository<Skill>,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  /**
   * 同步某创作者/团队名下所有「付费」技能的 member_included 标志。
   * 该 owner 配置了会员套餐 → memberIncluded=true（订阅者免费下）；
   * 套餐删除（若未来提供删除端点）→ 传 false 即可收回。
   * 与 PricingController.updatePricing 的自动派生互补，覆盖「先定价、后开套餐」的时序。
   */
  private async syncOwnerMemberIncluded(targetType: string, targetId: string, memberIncluded: boolean) {
    const where = targetType === 'team' ? { owner_team_id: targetId } : { owner_user_id: targetId };
    const skills = await this.skillRepo.find({ where, select: ['id'] });
    if (skills.length === 0) return;
    const ids = skills.map((s) => s.id);
    await this.skillPricingRepo
      .createQueryBuilder()
      .update(SkillPricing)
      .set({ member_included: memberIncluded })
      .where('skill_id IN (:...ids)', { ids })
      .andWhere('pricing_mode = :mode', { mode: 'paid' })
      .execute();
  }

  /** 创建订单并发起支付 */
  @Post('orders')
  async createOrder(@Req() req: Request, @Body() body: any) {
    try {
      return await this.orders.createOrder(this.uid(req), body);
    } catch (e: any) {
      // 包装一层：Nest 默认过滤器只打 "ExceptionsHandler" 单行、吞掉堆栈，
      // 排查下单 500 时看不到根因。这里带请求 body + 完整 stack 落日志。
      const masked = { ...(body || {}), skillId: body?.skillId ? '***' : body?.skillId };
      this.logger.error(`[create-order-500] uid=${(req as any).user?.sub} body=${JSON.stringify(masked)}`, e?.stack || e?.message || String(e));
      throw e;
    }
  }

  /** 查询订单状态（前端轮询；卡住自动查单） */
  @Get('orders/:orderNo/status')
  async status(@Req() req: Request, @Param('orderNo') orderNo: string) {
    return this.orders.getStatus(orderNo, this.uid(req));
  }

  /* 定价类只读接口已迁移到无鉴权的 PricingController（未登录也要能看价格） */

  /** 我的订单 */
  @Get('me/orders')
  async myOrders(@Req() req: Request) {
    return this.orders.myOrders(this.uid(req));
  }

  /** 我的会员状态（过渡期老全局会员） */
  @Get('me/membership')
  async myMembership(@Req() req: Request) {
    return this.membership.getMyLegacy(this.uid(req));
  }

  /** 我的创作者会员订阅列表 */
  @Get('me/memberships')
  async myCreatorMemberships(@Req() req: Request) {
    return this.membership.getMySubs(this.uid(req));
  }

  /**
   * 创作者会员套餐（需登录）：前端订阅弹窗在用户已登录时使用本接口；
   * 未登录场景请调用公开的 PricingController.creator-plan 接口。
   * 返回该创作者设置的月/季/年价格（分，0=未开通）与平台建议默认价。
   */
  @Get('membership/plan')
  // 0047：设置页点完「停售 / 释放 / 撤销」会 await load() 重读本接口，
  // 被缓存就会出现「点了没反应」的假故障。必须 no-store。
  @Header('Cache-Control', 'no-store')
  async membershipPlan(@Query('targetType') targetType: string, @Query('targetId') targetId: string) {
    if (!targetType || !targetId) throw new BadRequestException('缺少 targetType / targetId');
    const plan = await this.planRepo.findOne({ where: { target_type: targetType, target_id: targetId } });
    const suggested = await this.settings.getMembershipPrices();
    if (!plan) {
      return {
        hasPlan: false, plans: null, suggested, targetType, targetId,
        enabled: false, released: false, activeSubscribers: 0,
      };
    }
    // 0047：设置页需要实时售卖状态 + 有效订阅数，用于停售 / 释放的二次确认。
    let activeSubscribers = 0;
    if (targetType === 'team') {
      const rows = await this.planRepo.manager.query(
        `SELECT count(*)::int AS cnt FROM creator_subscriptions
          WHERE target_type = 'team' AND target_id = $1
            AND status = 'active' AND expires_at > now()`,
        [targetId],
      );
      activeSubscribers = Number(rows?.[0]?.cnt) || 0;
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
      enabled: (plan as any).enabled !== false,
      released: !!(plan as any).released_at,
      activeSubscribers,
    };
  }

  /** 某创作者的有效会员订阅数（供主页"X人订阅"展示，纯公开数据，无需登录） */
  @Public()
  @Get('membership/subscribers/:targetType/:targetId')
  async membershipSubscribers(@Param('targetType') targetType: string, @Param('targetId') targetId: string) {
    return { count: await this.membership.subscriberCount(targetType, targetId) };
  }

  /** 当前用户对该创作者的订阅状态 */
  @Get('membership/subscribe/:targetType/:targetId')
  async myMembershipTo(@Req() req: Request, @Param('targetType') targetType: string, @Param('targetId') targetId: string) {
    const sub = await this.csRepo.findOne({
      where: { user_id: this.uid(req), target_type: targetType, target_id: targetId, status: 'active', expires_at: MoreThan(new Date()) },
    });
    return sub ? { subscribed: true, plan: sub.plan, expires_at: sub.expires_at } : { subscribed: false };
  }

  /**
   * 创作者设置自己的会员价格（user 目标须本人；team 目标须团队 owner）。
   */
  @Put('membership/plan')
  async setMembershipPlan(@Req() req: Request, @Body() body: any) {
    const uid = this.uid(req);
    const { targetType, targetId, monthly_cents, quarterly_cents, yearly_cents } = body || {};
    if (!targetType || !targetId) throw new BadRequestException('缺少 targetType / targetId');

    if (targetType === 'user') {
      if (targetId !== uid) throw new ForbiddenException('只能设置自己的会员价格');
    } else if (targetType === 'team') {
      const team = await this.teamRepo.findOne({ where: { id: targetId } });
      if (!team) throw new NotFoundException('团队不存在');
      // 0047：私有团队外人连主页/技能详情都 403，连 402 都拿不到 ⇒ 开套餐是死功能。
      // 不自动置公开（隐式副作用），必须由团长到设置页显式开启「对外展示」。
      // ⚠️ 只拦「首次开套餐」：已有套餐的团队后来转私有，仍须允许团长改价 / 停售 /
      //    释放 / 撤销（这些是已有权益的管理动作），否则存量套餐被永久锁死无法维护。
      if (!team.is_public) {
        const hasPlan = await this.planRepo.findOne({
          where: { target_type: 'team', target_id: targetId },
          select: ['id'] as any,
        });
        if (!hasPlan) {
          throw new BadRequestException('开启订阅套餐前，请先在团队设置里将团队设为「对外展示」');
        }
      }
      // owner 或 maintainer 可设置 —— 与前端「管理」入口的 canManage = is_owner || is_manager
      // 保持一致。原先后端只认 owner_user_id，maintainer 在前端点得到按钮却必吃 403。
      const isOwner = team.owner_user_id === uid;
      const isMaintainer =
        !isOwner &&
        !!(await this.teamMemberRepo.findOne({
          where: { team_id: targetId, user_id: uid, role: MemberRole.MAINTAINER },
        }));
      if (!isOwner && !isMaintainer) {
        throw new ForbiddenException('只有团队所有者或管理员可设置会员价格');
      }
    } else {
      throw new BadRequestException('无效的 targetType');
    }

    const toCents = (v: any) => {
      const n = Math.max(0, Math.round(Number(v) || 0));
      if (n > 999900) throw new BadRequestException('价格过高');
      return n;
    };
    const m = toCents(monthly_cents);
    const q = toCents(quarterly_cents);
    const y = toCents(yearly_cents);
    if (m === 0 && q === 0 && y === 0) throw new BadRequestException('至少开启一个档位');

    const existing = await this.planRepo.findOne({ where: { target_type: targetType, target_id: targetId } });
    const row = existing || this.planRepo.create({ target_type: targetType, target_id: targetId });
    row.monthly_cents = m;
    row.quarterly_cents = q;
    row.yearly_cents = y;
    row.currency = 'CNY';
    const saved = await this.planRepo.save(row);
    // 0047：团队技能的下载权已完全由订阅墙判定，不再依赖技能级 member_included。
    // 仅保留 user（个人创作者）分支——个人会员仍靠它生效，绝不能一起停掉。
    if (targetType !== 'team') {
      await this.syncOwnerMemberIncluded(targetType, targetId, true);
    }
    return {
      targetType,
      targetId,
      plans: { monthly: saved.monthly_cents, quarterly: saved.quarterly_cents, yearly: saved.yearly_cents },
      enabled: (saved as any).enabled !== false,
      released: !!(saved as any).released_at,
    };
  }

  /** 0047 套餐管理权限：仅团队 owner / maintainer（与 setMembershipPlan 同口径）。 */
  private async assertTeamPlanManager(targetId: string, uid: string) {
    const team = await this.teamRepo.findOne({ where: { id: targetId } });
    if (!team) throw new NotFoundException('团队不存在');
    const isOwner = team.owner_user_id === uid;
    const isMaintainer =
      !isOwner &&
      !!(await this.teamMemberRepo.findOne({
        where: { team_id: targetId, user_id: uid, role: MemberRole.MAINTAINER },
      }));
    if (!isOwner && !isMaintainer) {
      throw new ForbiddenException('只有团队所有者或管理员可管理订阅套餐');
    }
    const plan = await this.planRepo.findOne({ where: { target_type: 'team', target_id: targetId } });
    if (!plan) throw new NotFoundException('该团队尚未设置订阅套餐');
    return plan;
  }

  /** 停售：不再接受新购/续费，已有订阅与订阅墙保持不变。 */
  @Put('membership/plan/stop')
  async stopTeamPlan(@Req() req: Request, @Body() body: any) {
    const targetId = body?.targetId;
    if (!targetId) throw new BadRequestException('缺少 targetId');
    const plan = await this.assertTeamPlanManager(targetId, this.uid(req));
    if (plan.released_at) throw new BadRequestException('该团队已释放，不可再变更售卖状态');
    plan.enabled = false;
    await this.planRepo.save(plan);
    return { targetId, enabled: false, released: false };
  }

  /** 重新启用：释放后禁止重新启用（避免「免费 → 墙回来」伤害用户预期）。 */
  @Put('membership/plan/resume')
  async resumeTeamPlan(@Req() req: Request, @Body() body: any) {
    const targetId = body?.targetId;
    if (!targetId) throw new BadRequestException('缺少 targetId');
    const plan = await this.assertTeamPlanManager(targetId, this.uid(req));
    if (plan.released_at) throw new BadRequestException('该团队已开放免费下载，不可重新启用套餐');
    plan.enabled = true;
    await this.planRepo.save(plan);
    return { targetId, enabled: true, released: false };
  }

  /** 立即释放：整团队技能立刻免费。前端必须二次确认（confirm=true），24h 内可撤销。 */
  @Post('membership/plan/release')
  async releaseTeamPlan(@Req() req: Request, @Body() body: any) {
    const targetId = body?.targetId;
    if (!targetId) throw new BadRequestException('缺少 targetId');
    const plan = await this.assertTeamPlanManager(targetId, this.uid(req));
    // 幂等保护：重复释放会刷新 released_at，等于把 24h 撤销窗口无限延长，必须拒绝。
    if (plan.released_at) throw new BadRequestException('该团队已释放，无需重复操作');
    const rows = await this.planRepo.manager.query(
      `SELECT count(*)::int AS cnt FROM creator_subscriptions
        WHERE target_type = 'team' AND target_id = $1
          AND status = 'active' AND expires_at > now()`,
      [targetId],
    );
    const activeSubscribers = Number(rows?.[0]?.cnt) || 0;
    if (body?.confirm !== true) {
      throw new BadRequestException(
        `释放后全部技能立即免费且不可重新启用；当前仍有 ${activeSubscribers} 个有效订阅，请确认后再操作`,
      );
    }
    // 先存释放前的 enabled，撤销时精确回滚（不把原本「停售」的团队隐式改回「售卖中」）。
    plan.enabled_before_release = plan.enabled;
    plan.released_at = new Date();
    plan.enabled = false;
    await this.planRepo.save(plan);
    return { targetId, enabled: false, released: true, activeSubscribers };
  }

  /** 撤销释放：24h 冷静期，给误操作一个逃生口。 */
  @Post('membership/plan/release/undo')
  async undoReleaseTeamPlan(@Req() req: Request, @Body() body: any) {
    const targetId = body?.targetId;
    if (!targetId) throw new BadRequestException('缺少 targetId');
    const plan = await this.assertTeamPlanManager(targetId, this.uid(req));
    if (!plan.released_at) throw new BadRequestException('该团队未处于释放状态');
    if (Date.now() - new Date(plan.released_at).getTime() > 24 * 3600_000) {
      throw new BadRequestException('释放已超过 24 小时，不可撤销');
    }
    // 精确回滚到释放前的售卖状态；无快照的历史行保守回到「停售」，绝不隐式重新开卖。
    plan.enabled = plan.enabled_before_release ?? false;
    plan.released_at = null;
    plan.enabled_before_release = null;
    await this.planRepo.save(plan);
    return { targetId, enabled: plan.enabled, released: false };
  }

  /** 发起创作者会员订阅下单 */
  @Post('membership/subscribe')
  async subscribeMembership(@Req() req: Request, @Body() body: any) {
    const { targetType, targetId, plan } = body || {};
    if (!targetType || !targetId || !plan) throw new BadRequestException('缺少 targetType / targetId / plan');
    return this.orders.createOrder(this.uid(req), { type: 'creator_membership', targetType, targetId, plan, tradeType: 'NATIVE' });
  }

  /** 我的余额 + 流水 */
  @Get('me/balances')
  async myBalance(@Req() req: Request) {
    const uid = this.uid(req);
    const bal = await this.balRepo.findOne({ where: { user_id: uid } });
    const txns = await this.txRepo.find({ where: { user_id: uid }, order: { created_at: 'DESC' }, take: 50 });
    // 提现收款走商家转账 → 需要公众号 openid（支付 AppID=公众号），故读 wechat_openid_oa 并显式 select（select:false 默认不加载）
    const user = await this.userRepo.findOne({ where: { id: uid }, select: ['id', 'wechat_openid_oa'] });
    return {
      balance: bal || { available_cents: 0, frozen_cents: 0, total_earned_cents: 0, total_withdrawn_cents: 0 },
      transactions: txns,
      withdrawMinCents: await this.settings.getWithdrawMinCents(),
      wechatBound: !!user?.wechat_openid_oa,
      // 结算冻结期后的实际可提额度，前端据此展示与禁用按钮
      withdrawable: await this.balance.getWithdrawableInfo(uid),
    };
  }

  /** 申请提现 */
  @Post('withdrawals')
  async createWithdrawal(@Req() req: Request, @Body() body: any) {
    const uid = this.uid(req);
    const user = await this.userRepo.findOne({ where: { id: uid }, select: ['id', 'wechat_openid_oa'] });
    if (!user?.wechat_openid_oa) throw new BadRequestException('请先在微信内打开本站完成一次登录（商家转账收款需要微信身份）');
    const amount = Math.round(Number(body.amountCents));
    const min = await this.settings.getWithdrawMinCents();
    if (!amount || amount < min) throw new BadRequestException(`最低提现 ${min / 100} 元`);

    // 按结算冻结期后的可提额度校验，而非账面余额：
    // 防止「今天成交 → 今天提走 → 明天退款」导致平台垫付无法追回。
    const info = await this.balance.getWithdrawableInfo(uid);
    if (amount > info.withdrawableCents) {
      const parts = [`当前可提现 ${(info.withdrawableCents / 100).toFixed(2)} 元`];
      if (info.frozenIncomeCents > 0) {
        parts.push(
          `另有 ${(info.frozenIncomeCents / 100).toFixed(2)} 元处于 ${info.settlementDelayDays} 天结算冻结期内`,
        );
      }
      if (info.pendingWithdrawCents > 0) {
        parts.push(`${(info.pendingWithdrawCents / 100).toFixed(2)} 元被待审提现单占用`);
      }
      throw new BadRequestException(parts.join('，'));
    }

    const outBillNo = `WD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const wd = this.wdRepo.create({
      user_id: uid,
      amount_cents: amount,
      fee_cents: 0,
      status: 'PENDING',
      channel: 'wechat_transfer',
      target_openid: user.wechat_openid_oa,
      real_name: body.realName || (user as any).real_name || null,
      out_bill_no: outBillNo,
    });
    const saved = await this.wdRepo.save(wd);

    // 并发兜底：上方按「可提额度」校验时，两步之间若另一笔申请同时插入，
    // 待审占用会发生并发绕过。插入后重算一次（此时 pending 已含本次），
    // 若扣掉冻结收入后仍不足以覆盖全部待审占用，则撤销本次，避免超额占用。
    // 审批时的 freeze 仍是最终防线（冻结不足直接失败），此处仅消除"并发产生失败单"的体验问题。
    const recheck = await this.balance.getWithdrawableInfo(uid);
    if (recheck.availableCents - recheck.frozenIncomeCents - recheck.pendingWithdrawCents < 0) {
      await this.wdRepo.remove(saved);
      throw new BadRequestException('提现额度不足或存在并发申请，请刷新后重试');
    }
    return saved;
  }

  /** 我的提现记录 */
  @Get('me/withdrawals')
  async myWithdrawals(@Req() req: Request) {
    const uid = this.uid(req);
    return this.wdRepo.find({ where: { user_id: uid }, order: { applied_at: 'DESC' } });
  }
}
