import { Controller, Post, Get, Patch, Delete, UseGuards, HttpCode, HttpException, HttpStatus, Query, Body, Param, Request } from '@nestjs/common';
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
  async batchUpdateSkills(@Body() body: { ids: string[]; action: string; tags?: string[] }, @Request() req: any) {
    const result = await this.adminService.batchUpdateSkills(body.ids, body.action, { tags: body.tags });
    await this.adminService.logAction(req.user.sub, body.action, 'skill', body.ids.join(','), `Updated ${body.ids.length} skills`);
    return result;
  }

  /**
   * PATCH /admin/skills/:id
   * Edit a single skill (admin override)
   */
  @Patch('skills/:id')
  async updateSkill(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateSkill(id, body);
  }

  // ── 用户 ──
  @Get('users')
  listUsers(@Query() q: any) { return this.adminService.listUsers(q); }

  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() b: any) { return this.adminService.updateUser(id, b); }

  // ── 标签 ──
  @Get('tags')
  getTags() { return this.adminService.getTags(); }

  // ── 评论 ──
  @Get('comments')
  listComments(@Query() q: any) { return this.adminService.listComments(q); }

  @Delete('comments/:id')
  deleteComment(@Param('id') id: string) { return this.adminService.deleteComment(id); }

  // ── 团队 ──
  @Get('teams')
  listTeams(@Query() q: any) { return this.adminService.listTeams(q); }

  @Patch('teams/:id')
  updateTeam(@Param('id') id: string, @Body() b: any) { return this.adminService.updateTeam(id, b); }

  @Delete('teams/:id')
  deleteTeam(@Param('id') id: string) { return this.adminService.deleteTeam(id); }

  // ── 日志 ──
  @Get('logs')
  listLogs(@Query() q: any) { return this.adminService.listLogs(q); }

  // ── 设置 ──
  @Get('settings')
  getSettings() { return this.adminService.getSettings(); }

  // ── 标签分组 ──
  @Get('tag-groups')
  listTagGroups() { return this.adminService.listTagGroups(); }

  @Post('tag-groups')
  createTagGroup(@Body() b: any) { return this.adminService.createTagGroup(b); }

  @Patch('tag-groups/:id')
  updateTagGroup(@Param('id') id: string, @Body() b: any) { return this.adminService.updateTagGroup(id, b); }

  @Delete('tag-groups/:id')
  deleteTagGroup(@Param('id') id: string) { return this.adminService.deleteTagGroup(id); }

  // ── 审核 ──
  @Get('reviews')
  listReviews(@Query() q: any) { return this.adminService.listReviews(q); }

  @Post('reviews/:id/approve')
  approveSkill(@Param('id') id: string, @Request() req: any) {
    return this.adminService.approveSkill(id);
  }

  @Post('reviews/:id/reject')
  rejectSkill(@Param('id') id: string, @Request() req: any) {
    return this.adminService.rejectSkill(id);
  }
}
