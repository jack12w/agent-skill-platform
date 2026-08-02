import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import {
  PAYMENT_ENTITIES,
  PlatformSetting,
  SkillPricing,
  Order,
  OrderItem,
  Payment,
  Refund,
  WechatNotifyLog,
  Entitlement,
  Membership,
  MembershipDownload,
  CreatorBalance,
  BalanceTransaction,
  Withdrawal,
  Settlement,
  ServiceOrder,
  SkillManifest,
  ApiCall,
} from './payments.entity';
import { User } from '../auth/user.entity';
import { Skill } from '../skills/skill.entity';
import { WechatPayService } from './wechat-pay.service';
import { SettingsService } from './settings.service';
import { EntitlementService } from './entitlement.service';
import { BalanceService } from './balance.service';
import { MembershipService } from './membership.service';
import { OrdersService } from './orders.service';
import { AdminPaymentsService } from './admin-payments.service';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { WechatNotifyController } from './wechat-notify.controller';
import { PricingController } from './pricing.controller';

const ENTITIES = [...PAYMENT_ENTITIES, User, Skill];

@Module({
  imports: [TypeOrmModule.forFeature(ENTITIES), AuthModule],
  providers: [
    WechatPayService,
    SettingsService,
    EntitlementService,
    BalanceService,
    MembershipService,
    OrdersService,
    AdminPaymentsService,
  ],
  controllers: [PricingController, PaymentsController, AdminPaymentsController, WechatNotifyController],
  exports: [EntitlementService, MembershipService, SettingsService, OrdersService],
})
export class PaymentsModule {}
