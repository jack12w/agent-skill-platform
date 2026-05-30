import { Controller, Post, HttpCode, HttpException, HttpStatus } from '@nestjs/common';
import { StatsAggregationService } from '../stats-aggregation.service';

/**
 * Admin maintenance endpoints — not exposed to the public in production.
 * In production, you can trigger these via an internal request or a cron job.
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly statsAggregation: StatsAggregationService) {}

  /**
   * POST /admin/sync-stats
   * Recalculates skill_stats from the events table and updates all scores.
   * Useful when leaderboard total-rank and weekly-rank show different numbers.
   */
  @Post('sync-stats')
  @HttpCode(200)
  async syncStats() {
    try {
      await this.statsAggregation.aggregateStats();
      return { ok: true, message: 'Stats synced from events table.' };
    } catch (err: any) {
      throw new HttpException(
        `Failed to sync stats: ${err.message || err}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
