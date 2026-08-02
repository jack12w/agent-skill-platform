import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Query,
  Param,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';
import { AdminPaymentsService } from './admin-payments.service';
import { SettingsService } from './settings.service';
import { RefundService } from './refund.service';

@Controller('admin/pay')
@UseGuards(AuthGuard, AdminGuard)
export class AdminPaymentsController {
  constructor(
    private readonly admin: AdminPaymentsService,
    private readonly settings: SettingsService,
    private readonly refunds: RefundService,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  @Get('orders')
  listOrders(@Query('page') page = '1', @Query('size') size = '20', @Query('status') status?: string) {
    return this.admin.listOrders(Number(page), Number(size), status);
  }

  @Get('memberships')
  listMemberships(@Query('page') page = '1', @Query('size') size = '20', @Query('status') status?: string) {
    return this.admin.listMemberships(Number(page), Number(size), status);
  }

  @Get('creators')
  listCreators(@Query('page') page = '1', @Query('size') size = '20') {
    return this.admin.listCreators(Number(page), Number(size));
  }

  @Get('withdrawals')
  listWithdrawals(@Query('page') page = '1', @Query('size') size = '20', @Query('status') status?: string) {
    return this.admin.listWithdrawals(Number(page), Number(size), status);
  }

  @Patch('withdrawals/:id/approve')
  approve(@Param('id') id: string, @Req() req: Request) {
    return this.admin.approveWithdrawal(id, this.uid(req));
  }

  @Get('reconciliation')
  reconcile() {
    return this.admin.reconcile();
  }

  /**
   * 发起退款（全额或部分）。退款成功后会自动回冲创作者余额、撤销权益/订阅。
   * body: { orderNo, amountCents?, reason? }  amountCents 缺省=全额退
   */
  @Post('refunds')
  async createRefund(@Body() body: any, @Req() req: Request) {
    const orderNo = String(body?.orderNo || '').trim();
    if (!orderNo) throw new BadRequestException('缺少 orderNo');
    const amount = body?.amountCents == null || body?.amountCents === '' ? undefined : Number(body.amountCents);
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      throw new BadRequestException('退款金额必须为正整数（分）');
    }
    return this.refunds.createRefund(orderNo, amount, String(body?.reason || '管理员退款'), this.uid(req));
  }

  /** 退款单列表 */
  @Get('refunds')
  listRefunds(@Query('page') page = '1', @Query('size') size = '20', @Query('status') status?: string) {
    return this.admin.listRefunds(Number(page), Number(size), status);
  }

  /** 交易设置：抽成比例 + 结算/提现规则 */
  @Get('settings')
  async settings_get() {
    return {
      commissionRateBp: await this.settings.getCommissionBp(),
      settlementDelayDays: await this.settings.getSettlementDelayDays(),
      withdrawMinCents: await this.settings.getWithdrawMinCents(),
    };
  }

  @Put('settings/commission')
  async updateCommission(@Body() body: any) {
    const bp = Number(body.commissionRateBp);
    if (!bp || bp < 0 || bp > 3000) throw new BadRequestException('抽成比例异常（0~30%）');
    return this.settings.set('commission_rate_bp', bp);
  }

  /** 结算与提现：冻结期天数 + 最低提现金额 */
  @Put('settings/payout')
  async updatePayout(@Body() body: any) {
    const days = Number(body.settlementDelayDays);
    const min = Number(body.withdrawMinCents);
    if (!Number.isInteger(days) || days < 0 || days > 90) {
      throw new BadRequestException('结算冻结期需为 0~90 的整数天');
    }
    if (!Number.isInteger(min) || min < 100 || min > 1_000_000) {
      throw new BadRequestException('最低提现需为 1~10000 元');
    }
    await this.settings.set('settlement_delay_days', days);
    await this.settings.set('withdraw_min_cents', min);
    return { settlementDelayDays: days, withdrawMinCents: min };
  }
}
