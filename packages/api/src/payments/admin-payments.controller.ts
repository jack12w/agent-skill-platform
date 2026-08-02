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
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';
import { AdminPaymentsService } from './admin-payments.service';
import { SettingsService } from './settings.service';

@Controller('admin/pay')
@UseGuards(AuthGuard, AdminGuard)
export class AdminPaymentsController {
  constructor(
    private readonly admin: AdminPaymentsService,
    private readonly settings: SettingsService,
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

  @Get('settlements')
  listSettlements(@Query('page') page = '1', @Query('size') size = '20') {
    return this.admin.listSettlements(Number(page), Number(size));
  }

  @Post('settlements/run')
  runSettlement(@Query('period') period: string) {
    if (!period || !/^\d{4}-\d{2}$/.test(period)) throw new Error('period 格式应为 YYYY-MM');
    return this.admin.runSettlement(period);
  }

  @Get('reconciliation')
  reconcile() {
    return this.admin.reconcile();
  }

  /** 交易设置：抽成比例 + 会员价 */
  @Get('settings')
  async settings_get() {
    return {
      commissionRateBp: await this.settings.getCommissionBp(),
      membershipPrices: await this.settings.getMembershipPrices(),
      settlementDelayDays: await this.settings.getSettlementDelayDays(),
      withdrawMinCents: await this.settings.getWithdrawMinCents(),
    };
  }

  @Put('settings/commission')
  async updateCommission(@Body() body: any) {
    const bp = Number(body.commissionRateBp);
    if (!bp || bp < 0 || bp > 3000) throw new Error('抽成比例异常（0~30%）');
    return this.settings.set('commission_rate_bp', bp);
  }

  @Put('settings/membership-prices')
  async updateMembershipPrices(@Body() body: any) {
    const prices = {
      monthly: Number(body.monthly),
      quarterly: Number(body.quarterly),
      yearly: Number(body.yearly),
    };
    if (!prices.monthly || !prices.quarterly || !prices.yearly) throw new Error('会员价不完整');
    return this.settings.set('membership_prices', prices);
  }
}
