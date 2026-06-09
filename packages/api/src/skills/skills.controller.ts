import { Controller, Post, Patch, Delete, Get, Body, UseGuards, Request, Param, Query, UseInterceptors, UploadedFile, BadRequestException, Res } from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
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
    if (query.owner === 'me') {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) throw new BadRequestException('Unauthorized');
      try {
        const payload = this.jwtService.decode(token) as { sub: string } | null;
        query.owner_id = payload?.sub;
        if (!query.owner_id) throw new BadRequestException('Invalid token');
      } catch {
        throw new BadRequestException('Invalid token');
      }
    }
    return this.skillsService.findAll(query);
  }

  @UseGuards(AuthGuard)
  @Post()
  create(@Body() body: any, @Request() req: any) {
    return this.skillsService.createSkill(body, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.skillsService.updateSkill(id, body, req.user.sub);
  }

  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.skillsService.listVersions(id);
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
  findOne(@Param('id') id: string) {
    return this.skillsService.findOne(id);
  }

  @Post(':id/like')
  @UseGuards(AuthGuard)
  like(@Param('id') id: string, @Request() req: any) {
    return this.skillsService.recordEvent(id, EventType.LIKE, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Get(':id/download/file')
  async downloadFile(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub);
    const { buffer, filename, raw } = await this.skillsService.streamDownload(id);
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
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub);
    const { buffer, filename, raw } = await this.skillsService.streamDownload(id, versionId);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(raw)}`,
    });
    res.send(buffer);
  }

  @UseGuards(AuthGuard)
  @Get(':id/download')
  async download(@Param('id') id: string, @Request() req: any) {
    // Resolve the real package URL of the latest version, then record the event.
    const result = await this.skillsService.getDownloadUrl(id);
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub);
    return result;
  }

  @UseGuards(AuthGuard)
  @Get(':id/versions/:versionId/download')
  async downloadVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Request() req: any,
  ) {
    const result = await this.skillsService.getDownloadUrl(id, versionId);
    await this.skillsService.recordEvent(id, EventType.DOWNLOAD, req.user.sub);
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
