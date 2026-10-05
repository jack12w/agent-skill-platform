import { Module } from '@nestjs/common';
import { AiAdminController } from './ai-admin.controller';

/**
 * AI 数据服务模块（方案 v2.1 §7/§10）。
 *
 * 首期只上管理看板聚合接口（只读）；push/query/keys 业务接口由 T105/T301 补入本模块。
 * DataSource 由 TypeOrmModule.forRoot 全局提供，此处直接注入即可；
 * 实体经 app.module 的 entities glob（所有 .entity.ts）自动注册。
 */
@Module({
  controllers: [AiAdminController],
})
export class AiModule {}
