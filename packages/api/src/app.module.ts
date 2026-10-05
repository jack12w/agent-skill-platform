import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { SkillsModule } from './skills/skills.module';
import { TeamsModule } from './teams/teams.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { CommonModule } from './common/common.module';
import { WechatModule } from './wechat/wechat.module';
import { PaymentsModule } from './payments/payments.module';
import { PluginsModule } from './plugins/plugins.module';
import { AiModule } from './ai/ai.module';
import { HealthController } from './common/health.controller';
import { AdminController } from './common/admin.controller';
import { AdminService } from './common/admin.service';
import { AdminGuard } from './common/admin.guard';
import { Skill } from './skills/skill.entity';
import { SkillVersion } from './skills/skill-version.entity';
import { User } from './auth/user.entity';
import { Team } from './teams/team.entity';
import { Comment } from './skills/comment.entity';
import { Event } from './skills/event.entity';
import { AdminLog } from './common/admin-log.entity';
import { TagGroup } from './common/tag-group.entity';
import { PageView } from './common/page-view.entity';
import { UserDailyActive } from './common/user-daily-active.entity';
import { Feedback } from './common/feedback.entity';
import { PublicTagGroupsController } from './common/public-tag-groups.controller';
import { AnalyticsController } from './common/analytics.controller';
import { FeedbackController } from './common/feedback.controller';
import { PresenceMiddleware } from './common/presence.middleware';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: false,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      // connectTimeoutMS 是 pg 驱动级别的超时，比 connectionTimeoutMillis 更底层
      connectTimeoutMS: 5000,
      // ── 连接池配置 ──
      extra: {
        max: 30,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 3000, // 3s 超时，本地 RDS 不通时快速失败
      },
      poolSize: 20,
      /**
       * ⚠️ 必须显式设成 `sql-null`（2026-09-27 生产事故根因之一）。
       *
       * TypeORM 0.3 的默认值是 `ignore`（见 `SelectQueryBuilder.buildWhere`：
       * `options.invalidWhereValuesBehavior?.null || "ignore"` → `continue`），
       * 意思是 **`where: { revoked_at: null }` 里的这个条件会被静默丢掉**，
       * 生成的 SQL 里**根本没有 `revoked_at IS NULL`**。后果：
       *   `count({ where: { ..., revoked_at: null } })` 实际数的是**全部行**（含已吊销），
       *   于是「解绑设备」写入 `revoked_at` 成功了，但名额永远不释放
       *   → 用户解绑后仍显示「已授权 1/1 台设备」，且 approve 永远报 ACTIVATION_LIMIT。
       *
       * 设成 `sql-null` 后裸 null 会正确生成 `IS NULL`。注意这**不能替代**显式
       * `IsNull()`：判据代码仍应写 `IsNull()`（TypeORM 报错信息也是这么要求的），
       * 这里只是给未来新写的查询兜底，避免同一个坑再踩一次。
       */
      invalidWhereValuesBehavior: { null: 'sql-null' },
      // 开发环境减少重试，避免卡住启动
      retryAttempts: process.env.NODE_ENV === 'production' ? 10 : 2,
      retryDelay: 3000,
    }),
    TypeOrmModule.forFeature([Skill, SkillVersion, User, Team, Comment, Event, AdminLog, TagGroup, PageView, Feedback, UserDailyActive]),
    StorageModule,
    AuthModule,
    SkillsModule,
    TeamsModule,
    LeaderboardModule,
    UsersModule,
    SubscriptionsModule,
    CommonModule,
    WechatModule,
    PaymentsModule,
    PluginsModule,
    AiModule,
  ],
  controllers: [HealthController, AdminController, PublicTagGroupsController, AnalyticsController, FeedbackController],
  providers: [AdminService, AdminGuard],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // 全局用户活跃追踪：任何带有效 token 的请求节流更新 users.last_seen_at。
    // JwtModule 在 AuthModule 注册为 global，JwtService 此处可直接注入。
    consumer.apply(PresenceMiddleware).forRoutes('*');
  }
}
