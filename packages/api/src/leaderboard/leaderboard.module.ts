import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardSnapshot } from './leaderboard-snapshot.entity';
import { SkillStats } from '../skills/skill-stats.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([LeaderboardSnapshot, SkillStats]),
  ],
  providers: [LeaderboardService],
  controllers: [LeaderboardController],
})
export class LeaderboardModule {}
