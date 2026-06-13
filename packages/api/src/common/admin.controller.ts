import { Controller, Post, Get, Patch, Delete, UseGuards, HttpCode, HttpException, HttpStatus, Query, Body, Param } from '@nestjs/common';
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

  /**
   * GET /admin/skills
   * List all skills with search/filter/pagination
   */
  @Get('skills')
  async listSkills(@Query() q: any) {
    return this.adminService.listSkills(q);
  }

  /**
   * PATCH /admin/skills/batch
   * Batch publish/unpublish/delete/retag skills
   */
  @Patch('skills/batch')
  async batchUpdateSkills(@Body() body: { ids: string[]; action: string; tags?: string[] }) {
    return this.adminService.batchUpdateSkills(body.ids, body.action, { tags: body.tags });
  }

  /**
   * PATCH /admin/skills/:id
   * Edit a single skill (admin override)
   */
  @Patch('skills/:id')
  async updateSkill(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateSkill(id, body);
  }
}
