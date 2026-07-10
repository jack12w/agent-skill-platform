import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { SkillsModule } from './skills/skills.module';
import { TeamsModule } from './teams/teams.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
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
import { Feedback } from './common/feedback.entity';
import { PublicTagGroupsController } from './common/public-tag-groups.controller';
import { AnalyticsController } from './common/analytics.controller';
import { FeedbackController } from './common/feedback.controller';

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
      // 开发环境减少重试，避免卡住启动
      retryAttempts: process.env.NODE_ENV === 'production' ? 10 : 2,
      retryDelay: 3000,
    }),
    TypeOrmModule.forFeature([Skill, SkillVersion, User, Team, Comment, Event, AdminLog, TagGroup, PageView, Feedback]),
    StorageModule,
    AuthModule,
    SkillsModule,
    TeamsModule,
    LeaderboardModule,
    UsersModule,
    SubscriptionsModule,
  ],
  controllers: [HealthController, AdminController, PublicTagGroupsController, AnalyticsController, FeedbackController],
  providers: [AdminService, AdminGuard],
})
export class AppModule {}
