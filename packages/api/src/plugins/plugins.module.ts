import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { PluginsService } from './plugins.service';
import { PluginsController } from './plugins.controller';
import { PaymentsModule } from '../payments/payments.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Plugin, PluginSubscription]),
    PaymentsModule, // 复用 OrdersService 下单 + 微信支付
    StorageModule, // 复用 OssService 签名下载
  ],
  controllers: [PluginsController],
  providers: [PluginsService],
  exports: [PluginsService],
})
export class PluginsModule {}
