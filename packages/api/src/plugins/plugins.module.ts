import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { PluginAuthRequest, PluginDevice } from './plugin-auth.entity';
import { User } from '../auth/user.entity';
import { PluginsService } from './plugins.service';
import { PluginsAuthService } from './plugins-auth.service';
import { PluginsController } from './plugins.controller';
import { PluginsAdminController } from './plugins-admin.controller';
import { PaymentsModule } from '../payments/payments.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    // User 需在此注册：设备授权轮询成功时要回邮箱/昵称给插件展示
    TypeOrmModule.forFeature([
      Plugin,
      PluginSubscription,
      PluginDevice,
      PluginAuthRequest,
      User,
    ]),
    PaymentsModule, // 复用 OrdersService 下单 + 微信支付
    StorageModule, // 复用 OssService 签名下载
  ],
  controllers: [PluginsController, PluginsAdminController],
  providers: [PluginsService, PluginsAuthService],
  exports: [PluginsService, PluginsAuthService],
})
export class PluginsModule {}
