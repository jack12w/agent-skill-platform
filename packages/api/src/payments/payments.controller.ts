import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { MembershipService } from './membership.service';
import { SettingsService } from './settings.service';
import { BalanceService } from './balance.service';
import { CreatorBalance, BalanceTransaction, Withdrawal } from './payments.entity';
import { User } from '../auth/user.entity';

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

  /** 我的会员状态 */
  @Get('me/membership')
  async myMembership(@Req() req: Request) {
    return this.membership.getMy(this.uid(req));
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
