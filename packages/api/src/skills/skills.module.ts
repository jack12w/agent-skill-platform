import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SkillsService } from './skills.service';
import { SkillsController } from './skills.controller';
import { GeoController } from './geo.controller';
import { Skill } from './skill.entity';
import { SkillVersion } from './skill-version.entity';
import { Event } from './event.entity';
import { SkillStats } from './skill-stats.entity';
import { Comment } from './comment.entity';
import { LeaderboardSnapshot } from '../leaderboard/leaderboard-snapshot.entity';
import { TeamMember } from '../teams/team-member.entity';
import { Team } from '../teams/team.entity';
import { Subscription } from '../subscriptions/subscription.entity';
import { SkillPricing, CreatorMembershipPlan, CreatorSubscription } from '../payments/payments.entity';
import { StatsAggregationService } from '../stats-aggregation.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Skill, SkillVersion, Event, SkillStats, Comment, LeaderboardSnapshot, TeamMember, Team, Subscription, SkillPricing, CreatorMembershipPlan, CreatorSubscription]),
    PaymentsModule,
  ],
  providers: [SkillsService, StatsAggregationService],
  controllers: [SkillsController, GeoController],
  exports: [SkillsService, StatsAggregationService],
})
export class SkillsModule {}
