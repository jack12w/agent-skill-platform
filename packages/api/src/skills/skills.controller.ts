import { Controller, Post, Patch, Delete, Get, Body, UseGuards, Request, Param, Query, UseInterceptors, UploadedFile, UploadedFiles, BadRequestException, Res } from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { SkillsService } from './skills.service';
import { AuthGuard } from '../auth/auth.guard';
import { EventType } from '@platform/shared';

@Controller('skills')
export class SkillsController {
  constructor(
    private skillsService: SkillsService,
    private jwtService: JwtService,
  ) {}

  @Get()
  findAll(@Query() query: any, @Request() req: any) {
    let userId: string | undefined;
    if (query.owner === 'me') {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) throw new BadRequestException('Unauthorized');
      try {
        const payload = this.jwtService.decode(token) as { sub: string } | null;
        query.owner_id = payload?.sub;
        userId = payload?.sub;
        if (!query.owner_id) throw new BadRequestException('Invalid token');
      } catch {
        throw new BadRequestException('Invalid token');
      }
    } else {
      // Extract userId for authenticated users to check update status
      const token = req.headers.authorization?.split(' ')[1];
      if (token) {
        try {
          const payload = this.jwtService.decode(token) as { sub: string } | null;
          userId = payload?.sub || undefined;
        } catch { /* ignore */ }
      }
    }
    return this.skillsService.findAll(query, userId);
  }

  @UseGuards(AuthGuard)
  @Post()
  create(@Body() body: any, @Request() req: any) {
    return this.skillsService.createSkill(body, req.user.sub);
  }

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
  versions(@Param('id') id: string, @Request() req: any) {
    let userId: string | undefined;
    let isAdmin = false;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const payload = this.jwtService.decode(token) as { sub: string; role?: string } | null;
        userId = payload?.sub || undefined;
        isAdmin = payload?.role === 'admin';
      } catch { /* ignore */ }
    }
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
  findOne(@Param('id') id: string, @Request() req: any) {
    let userId: string | undefined;
    let isAdmin = false;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const payload = this.jwtService.decode(token) as { sub: string; role?: string } | null;
        userId = payload?.sub || undefined;
        isAdmin = payload?.role === 'admin';
      } catch { /* ignore */ }
    }
    return this.skillsService.findOne(id, userId, false, isAdmin);
  }

  @Post(':id/like')
  @UseGuards(AuthGuard)
  like(@Param('id') id: string, @Request() req: any) {
    return this.skillsService.recordEvent(id, EventType.LIKE, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Get(':id/download/file')
  async downloadFile(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    const isAdmin = req.user?.role === 'admin';
    const dlInfo = await this.skillsService.getDownloadUrl(id, undefined, req.user.sub, isAdmin);
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub, undefined, { version_id: dlInfo.version_id, version: dlInfo.version });
    const { buffer, filename, raw } = await this.skillsService.streamDownload(id, undefined, req.user.sub, isAdmin);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(raw)}`,
    });
    res.send(buffer);
  }

  @UseGuards(AuthGuard)
  @Get(':id/versions/:versionId/download/file')
  async downloadVersionFile(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const isAdmin = req.user?.role === 'admin';
    const dlInfo = await this.skillsService.getDownloadUrl(id, versionId, req.user.sub, isAdmin);
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub, undefined, { version_id: dlInfo.version_id, version: dlInfo.version });
    const { buffer, filename, raw } = await this.skillsService.streamDownload(id, versionId, req.user.sub, isAdmin);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(raw)}`,
    });
    res.send(buffer);
  }

  @UseGuards(AuthGuard)
  @Get(':id/download')
  async download(@Param('id') id: string, @Request() req: any) {
    const result = await this.skillsService.getDownloadUrl(id, undefined, req.user.sub);
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
    const result = await this.skillsService.getDownloadUrl(id, versionId, req.user.sub);
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
