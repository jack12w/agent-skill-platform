import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { OrdersService } from './orders.service';
import { MembershipService } from './membership.service';
import { SettingsService } from './settings.service';
import { BalanceService } from './balance.service';
import { CreatorBalance, BalanceTransaction, Withdrawal, CreatorMembershipPlan, CreatorSubscription } from './payments.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';

@Controller('pay')
@UseGuards(AuthGuard)
export class PaymentsController {
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
    @InjectRepository(CreatorMembershipPlan) private readonly planRepo: Repository<CreatorMembershipPlan>,
    @InjectRepository(CreatorSubscription) private readonly csRepo: Repository<CreatorSubscription>,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  /** 创建订单并发起支付 */
  @Post('orders')
  async createOrder(@Req() req: Request, @Body() body: any) {
    return this.orders.createOrder(this.uid(req), body);
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
   * 创作者会员套餐（公开）：供订阅弹窗展示。
   * 返回该创作者设置的月/季/年价格（分，0=未开通）与平台建议默认价。
   */
  @Get('membership/plan')
  async membershipPlan(@Query('targetType') targetType: string, @Query('targetId') targetId: string) {
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

  /** 某创作者的有效会员订阅数（供主页"X人订阅"展示） */
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
      if (team.owner_user_id !== uid) throw new ForbiddenException('只有团队所有者可设置会员价格');
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
    return {
      targetType,
      targetId,
      plans: { monthly: saved.monthly_cents, quarterly: saved.quarterly_cents, yearly: saved.yearly_cents },
    };
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
    const user = await this.userRepo.findOne({ where: { id: uid } });
    return {
      balance: bal || { available_cents: 0, frozen_cents: 0, total_earned_cents: 0, total_withdrawn_cents: 0 },
      transactions: txns,
      withdrawMinCents: await this.settings.getWithdrawMinCents(),
      wechatBound: !!user?.wechat_openid,
      // 结算冻结期后的实际可提额度，前端据此展示与禁用按钮
      withdrawable: await this.balance.getWithdrawableInfo(uid),
    };
  }

  /** 申请提现 */
  @Post('withdrawals')
  async createWithdrawal(@Req() req: Request, @Body() body: any) {
    const uid = this.uid(req);
    const user = await this.userRepo.findOne({ where: { id: uid } });
    if (!user?.wechat_openid) throw new BadRequestException('请先在账号绑定微信');
    const amount = Number(body.amountCents);
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
      target_openid: user.wechat_openid,
      real_name: body.realName || (user as any).real_name || null,
      out_bill_no: outBillNo,
    });
    return this.wdRepo.save(wd);
  }

  /** 我的提现记录 */
  @Get('me/withdrawals')
  async myWithdrawals(@Req() req: Request) {
    const uid = this.uid(req);
    return this.wdRepo.find({ where: { user_id: uid }, order: { applied_at: 'DESC' } });
  }
}
