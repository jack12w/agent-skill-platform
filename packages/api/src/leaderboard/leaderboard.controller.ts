import { Controller, Get, Query } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardType, LeaderboardPeriod } from '@platform/shared';

@Controller('leaderboard')
export class LeaderboardController {
  constructor(private leaderboardService: LeaderboardService) {}

  @Get()
  getLeaderboard(
    @Query('type') type: LeaderboardType = LeaderboardType.PERSONAL,
    @Query('period') period: LeaderboardPeriod = LeaderboardPeriod.ALL,
  ) {
    return this.leaderboardService.getSnapshot(type, period);
  }
}
