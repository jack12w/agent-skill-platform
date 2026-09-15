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
  CreatorBalance,
  BalanceTransaction,
  Withdrawal,
} from './payments.entity';
import { User } from '../auth/user.entity';
import { Skill } from '../skills/skill.entity';
import { Team } from '../teams/team.entity';
import { TeamMember } from '../teams/team-member.entity';
// 插件订阅：OrdersService.deliver 需按 order.type='plugin' 授予订阅，故这两个仓库
// 必须注册进本模块的 forFeature，否则 api 启动注入失败 → 502（红线）。
import { Plugin, PluginSubscription } from '../plugins/plugin.entity';
import { WechatPayService } from './wechat-pay.service';
import { SettingsService } from './settings.service';
import { EntitlementService } from './entitlement.service';
import { BalanceService } from './balance.service';
import { MembershipService } from './membership.service';
import { OrdersService } from './orders.service';
import { RefundService } from './refund.service';
import { AdminPaymentsService } from './admin-payments.service';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { WechatNotifyController } from './wechat-notify.controller';
import { PricingController } from './pricing.controller';

const ENTITIES = [
  ...PAYMENT_ENTITIES,
  User,
  Skill,
  Team,
  TeamMember,
  Plugin,
  PluginSubscription,
];

@Module({
  imports: [TypeOrmModule.forFeature(ENTITIES), AuthModule],
  providers: [
    WechatPayService,
    SettingsService,
    EntitlementService,
    BalanceService,
    MembershipService,
    OrdersService,
    RefundService,
    AdminPaymentsService,
  ],
  controllers: [PricingController, PaymentsController, AdminPaymentsController, WechatNotifyController],
  exports: [EntitlementService, MembershipService, SettingsService, OrdersService, RefundService],
})
export class PaymentsModule {}
