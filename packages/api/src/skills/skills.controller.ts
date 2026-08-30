import { Controller, Post, Patch, Delete, Get, Body, UseGuards, Request, Param, Query, UseInterceptors, UploadedFile, UploadedFiles, BadRequestException } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { SkillsService } from './skills.service';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';
import { IdentityService, extractBearerToken } from '../auth/identity.service';
import { EventType } from '@platform/shared';

@Controller('skills')
export class SkillsController {
  constructor(
    private skillsService: SkillsService,
    private identity: IdentityService,
  ) {}

  @Get()
  async findAll(@Query() query: any, @Request() req: any) {
    let userId: string | undefined;
    if (query.owner === 'me') {
      // 「我的技能」必须已登录：无 token / token 无效都拒绝。
      // 这里必须真验签 —— decode() 不验签意味着随便构造一个裸 JWT 就能列出他人的草稿。
      // 保持原有的 400 语义（前端已适配），不改成 401 以免破坏现有交互。
      const token = extractBearerToken(req);
      if (!token) throw new BadRequestException('Unauthorized');
      const payload = await this.identity.verify(token);
      if (!payload?.sub) throw new BadRequestException('Invalid token');
      query.owner_id = payload.sub;
      userId = payload.sub;
    } else {
      // 公开列表：登录可选，token 无效按匿名处理（保持原有 catch 后忽略的行为）
      const identity = await this.identity.fromRequest(req);
      userId = identity.userId;
    }
    return this.skillsService.findAll(query, userId);
  }

  @UseGuards(AuthGuard)
  @Post()
  create(@Body() body: any, @Request() req: any) {
    return this.skillsService.createSkill(body, req.user.sub);
  }

  // 全表重写标签的运维操作，原先无任何守卫 —— 匿名一个 POST 就能改写全库 tags。
  @UseGuards(AuthGuard, AdminGuard)
  @Post('fix-tags')
  fixTags() {
    return this.skillsService.fixAllTags();
  }

  @UseGuards(AuthGuard)
  @Post('batch')
  @UseInterceptors(FilesInterceptor('files', 50, { limits: { fileSize: 300 * 1024 } }))
  batchUpload(@UploadedFiles() files: any[], @Request() req: any, @Body('tags') tags?: string) {
    if (!files || files.length === 0) throw new BadRequestException('At least one file is required');
    const tagList = ['社区', 'SkillDepot', ...(tags ? tags.split(/[,，]/).map((t: string) => t.trim()).filter(Boolean) : [])];
    return this.skillsService.batchUpload(
      files.map(f => ({ buffer: f.buffer, originalname: f.originalname })),
      req.user.sub,
      tagList,
    );
  }

  @UseGuards(AuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.skillsService.updateSkill(id, body, req.user.sub);
  }

  @Get('check-name')
  checkName(@Query('name') name: string) {
    if (!name || !name.trim()) return { similar: [] };
    return this.skillsService.checkSimilarName(name.trim()).then(similar => ({ similar }));
  }

  @Get(':id/versions')
  async versions(@Param('id') id: string, @Request() req: any) {
    // 登录可选；token 无效按匿名处理。isAdmin 经回库核对，伪造 token 拿不到未发布版本。
    const { userId, isAdmin } = await this.identity.fromRequest(req);
    return this.skillsService.listVersions(id, userId, isAdmin);
  }

  @UseGuards(AuthGuard)
  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 300 * 1024,  // 300KB 文件大小上限
      fieldSize: 10 * 1024 * 1024, // 10MB 表单字段上限（notes 描述等）
    },
  }))
  uploadVersion(@Param('id') id: string, @UploadedFile() file: any, @Request() req: any, @Body('notes') notes?: string) {
    if (!file) throw new BadRequestException('File is required');
    if (file.mimetype !== 'application/zip' && file.mimetype !== 'application/x-zip-compressed') {
      throw new BadRequestException('Only ZIP files are allowed');
    }
    return this.skillsService.createVersion(id, file.buffer, req.user.sub, notes);
  }

  @UseGuards(AuthGuard)
  @Delete(':id/versions/:versionId')
  deleteVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Request() req: any,
  ) {
    return this.skillsService.deleteVersion(id, versionId, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Delete(':id')
  deleteSkill(@Param('id') id: string, @Request() req: any) {
    return this.skillsService.deleteSkill(id, req.user.sub);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req: any) {
    const { userId, isAdmin } = await this.identity.fromRequest(req);
    const result = await this.skillsService.findOne(id, userId, false, isAdmin);
    await this.skillsService.assertSkillTeamVisible(id, userId, isAdmin);
    return result;
  }

  /** 详情页聚合接口：技能+版本+定价+作者套餐+订阅状态 一次返回（降低限流压力） */
  @Get(':id/detail')
  async getDetail(@Param('id') id: string, @Request() req: any) {
    const { userId, isAdmin } = await this.identity.fromRequest(req);
    return this.skillsService.getDetail(id, userId, isAdmin);
  }

  @Post(':id/like')
  @UseGuards(AuthGuard)
  like(@Param('id') id: string, @Request() req: any) {
    return this.skillsService.recordEvent(id, EventType.LIKE, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Get(':id/download')
  async download(@Param('id') id: string, @Request() req: any) {
    const result = await this.skillsService.getDownloadUrl(id, undefined, req.user.sub, req.user?.role === 'admin');
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub, undefined, { version_id: result.version_id, version: result.version });
    return result;
  }

  @UseGuards(AuthGuard)
  @Get(':id/versions/:versionId/download')
  async downloadVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Request() req: any,
  ) {
    const result = await this.skillsService.getDownloadUrl(id, versionId, req.user.sub, req.user?.role === 'admin');
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub, undefined, { version_id: result.version_id, version: result.version });
    return result;
  }

  // ── 评论 ─────────────────────────────────
  @Get(':id/comments')
  getComments(@Param('id') id: string) {
    return this.skillsService.getComments(id);
  }

  @UseGuards(AuthGuard)
  @Post(':id/comments')
  createComment(@Param('id') id: string, @Request() req: any, @Body() body: { content: string }) {
    return this.skillsService.createComment(id, req.user.sub, body.content);
  }

  @UseGuards(AuthGuard)
  @Delete(':id/comments/:commentId')
  deleteComment(@Param('commentId') commentId: string, @Request() req: any) {
    return this.skillsService.deleteComment(commentId, req.user.sub);
  }
}
