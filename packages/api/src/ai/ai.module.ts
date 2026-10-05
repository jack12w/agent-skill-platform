import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiAdminController } from './ai-admin.controller';
import { AiPushController } from './ai-push.controller';
import { AiKeysController } from './ai-keys.controller';
import { AiQueryController } from './ai-query.controller';
import { Plugin, PluginSubscription } from '../plugins/plugin.entity';
import { PluginDevice } from '../plugins/plugin-auth.entity';
import { AiApiKey } from './ai-api-key.entity';

/**
 * AI 数据服务模块（方案 v2.1 §7/§10）。
 *
 * 已上线：管理看板聚合接口（T404，只读）+ push 推送接口（T105）
 *        + keys 密钥管理（T301，用户 JWT）+ query 取数（T301，ai_sk_ Bearer）。
 * 待补：MCP server（T303）。
 * DataSource 由 TypeOrmModule.forRoot 全局提供；实体经 app.module 的 entities glob 自动注册。
 * PluginDevice/PluginSubscription/Plugin 仓库用于 push/query 的令牌校验与订阅判定
 * （复用 plugins 模块的 util 口径，但不注入 plugins 的 service —— 避免跨模块 DI 纠缠）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Plugin, PluginSubscription, PluginDevice, AiApiKey])],
  controllers: [AiAdminController, AiPushController, AiKeysController, AiQueryController],
})
export class AiModule {}
