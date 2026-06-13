import { Controller, Post, Get, UseGuards, HttpCode, HttpException, HttpStatus } from '@nestjs/common';
import { StatsAggregationService } from '../stats-aggregation.service';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from '../auth/auth.guard';

/**
 * Admin endpoints — protected by AuthGuard + AdminGuard.
 */
@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly statsAggregation: StatsAggregationService,
    private readonly adminService: AdminService,
  ) {}

  /**
   * GET /admin/stats
   * Dashboard overview stats
   */
  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  /**
   * POST /admin/sync-stats
   * Recalculates skill_stats from the events table and updates all scores.
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
