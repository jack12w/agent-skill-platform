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
import { StatsAggregationService } from '../stats-aggregation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Skill, SkillVersion, Event, SkillStats, Comment, LeaderboardSnapshot, TeamMember]),
  ],
  providers: [SkillsService, StatsAggregationService],
  controllers: [SkillsController, GeoController],
  exports: [SkillsService, StatsAggregationService],
})
export class SkillsModule {}
