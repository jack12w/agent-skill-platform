import { Controller, Post, Get, Patch, Delete, UseGuards, HttpCode, HttpException, HttpStatus, Query, Body, Param, Request } from '@nestjs/common';
import { StatsAggregationService } from '../stats-aggregation.service';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from '../auth/auth.guard';

/**
 * Admin endpoints — protected by AuthGuard + AdminGuard.
 * All write operations log to admin_logs table.
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
   */
  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  /**
   * POST /admin/sync-stats
   */
  @Post('sync-stats')
  @HttpCode(200)
  async syncStats(@Request() req: any) {
    try {
      await this.statsAggregation.aggregateStats();
      await this.adminService.logAction(req.user.sub, 'sync_stats', 'system', '', 'Recalculated all skill scores from events');
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
   */
  @Get('skills')
  async listSkills(@Query() q: any) {
    return this.adminService.listSkills(q);
  }

  /**
   * PATCH /admin/skills/batch
   */
  @Patch('skills/batch')
  async batchUpdateSkills(@Body() body: { ids: string[]; action: string; tags?: string[] }, @Request() req: any) {
    const result = await this.adminService.batchUpdateSkills(body.ids, body.action, { tags: body.tags });
    await this.adminService.logAction(req.user.sub, body.action, 'skill', body.ids.join(','), `Batch ${body.action} ${body.ids.length} skills`);
    return result;
  }

  /**
   * PATCH /admin/skills/:id
   */
  @Patch('skills/:id')
  async updateSkill(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const result = await this.adminService.updateSkill(id, body);
    await this.adminService.logAction(req.user.sub, 'update_skill', 'skill', id, `Updated skill: ${body.name || id}`);
    return result;
  }

  // ── 用户 ──
  @Get('users')
  listUsers(@Query() q: any) { return this.adminService.listUsers(q); }

  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() b: any, @Request() req: any) {
    const result = await this.adminService.updateUser(id, b);
    await this.adminService.logAction(req.user.sub, 'update_user', 'user', id, `Updated user role: ${b.role || 'unchanged'}`);
    return result;
  }

  // ── 标签 ──
  @Get('tags')
  getTags() { return this.adminService.getTags(); }

  // ── 评论 ──
  @Get('comments')
  listComments(@Query() q: any) { return this.adminService.listComments(q); }

  @Delete('comments/:id')
  async deleteComment(@Param('id') id: string, @Request() req: any) {
    const result = await this.adminService.deleteComment(id);
    await this.adminService.logAction(req.user.sub, 'delete_comment', 'comment', id, 'Deleted comment');
    return result;
  }

  // ── 团队 ──
  @Get('teams')
  listTeams(@Query() q: any) { return this.adminService.listTeams(q); }

  @Patch('teams/:id')
  async updateTeam(@Param('id') id: string, @Body() b: any, @Request() req: any) {
    const result = await this.adminService.updateTeam(id, b);
    await this.adminService.logAction(req.user.sub, 'update_team', 'team', id, `Updated team: ${b.name || id}`);
    return result;
  }

  @Delete('teams/:id')
  async deleteTeam(@Param('id') id: string, @Request() req: any) {
    const result = await this.adminService.deleteTeam(id);
    await this.adminService.logAction(req.user.sub, 'delete_team', 'team', id, 'Deleted team');
    return result;
  }

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
  async createTagGroup(@Body() b: any, @Request() req: any) {
    const result = await this.adminService.createTagGroup(b);
    await this.adminService.logAction(req.user.sub, 'create_tag_group', 'tag_group', '', `Created tag group: ${b.displayName}`);
    return result;
  }

  @Patch('tag-groups/:id')
  async updateTagGroup(@Param('id') id: string, @Body() b: any, @Request() req: any) {
    const result = await this.adminService.updateTagGroup(id, b);
    await this.adminService.logAction(req.user.sub, 'update_tag_group', 'tag_group', id, `Updated tag group: ${b.displayName || id}`);
    return result;
  }

  @Delete('tag-groups/:id')
  async deleteTagGroup(@Param('id') id: string, @Request() req: any) {
    const result = await this.adminService.deleteTagGroup(id);
    await this.adminService.logAction(req.user.sub, 'delete_tag_group', 'tag_group', id, 'Deleted tag group');
    return result;
  }

  // ── 审核 ──
  @Get('reviews')
  listReviews(@Query() q: any) { return this.adminService.listReviews(q); }

  @Post('reviews/:id/approve')
  async approveSkill(@Param('id') id: string, @Request() req: any) {
    const result = await this.adminService.approveSkill(id);
    await this.adminService.logAction(req.user.sub, 'approve_skill', 'skill', id, 'Approved skill');
    return result;
  }

  @Post('reviews/:id/reject')
  async rejectSkill(@Param('id') id: string, @Request() req: any) {
    const result = await this.adminService.rejectSkill(id);
    await this.adminService.logAction(req.user.sub, 'reject_skill', 'skill', id, 'Rejected skill');
    return result;
  }

  // ── 统计 ──
  @Get('analytics')
  getAnalytics() { return this.adminService.getAnalytics(); }

  // ── 反馈 ──
  @Get('feedbacks')
  listFeedbacks(@Query() q: any) { return this.adminService.listFeedbacks(q); }

  @Delete('feedbacks/:id')
  async deleteFeedback(@Param('id') id: string, @Request() req: any) {
    const result = await this.adminService.deleteFeedback(id);
    await this.adminService.logAction(req.user.sub, 'delete_feedback', 'feedback', id, 'Deleted feedback');
    return result;
  }
}
