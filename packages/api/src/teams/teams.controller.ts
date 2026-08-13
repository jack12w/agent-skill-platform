import { Controller, Post, Patch, Delete, Get, Body, UseGuards, Request, Param, BadRequestException } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { MemberRole } from '@platform/shared';

@Controller('teams')
export class TeamsController {
  constructor(private teamsService: TeamsService) {}

  @UseGuards(AuthGuard)
  @Post()
  create(@Body() body: any, @Request() req: any) {
    return this.teamsService.createTeam(body.name, body.description, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Get('my')
  getMyTeams(@Request() req: any) {
    return this.teamsService.getMyTeams(req.user.sub);
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.teamsService.findOne(id, req.user?.sub);
  }

  @UseGuards(AuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.teamsService.updateTeam(id, body, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.teamsService.deleteTeam(id, req.user.sub);
  }

  // ── 成员管理（仅团队 owner 可操作，权限校验在 service 层）──
  @UseGuards(AuthGuard)
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const role = this.parseRole(body?.role);
    return this.teamsService.addMemberByEmail(id, body?.email, role, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Patch(':id/members/:userId')
  updateMember(@Param('id') id: string, @Param('userId') userId: string, @Body() body: any, @Request() req: any) {
    const role = this.parseRole(body?.role, true);
    return this.teamsService.updateMemberRole(id, userId, role, req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string, @Request() req: any) {
    return this.teamsService.removeMember(id, userId, req.user.sub);
  }

  // 仅允许 maintainer / viewer；owner 不可通过接口指定
  private parseRole(raw: string | undefined, required = false): MemberRole {
    if (!raw) {
      if (required) throw new BadRequestException('Role is required');
      return MemberRole.VIEWER;
    }
    const r = String(raw).toLowerCase();
    if (r !== MemberRole.MAINTAINER && r !== MemberRole.VIEWER) {
      throw new BadRequestException('Invalid role, only maintainer or viewer allowed');
    }
    return r as MemberRole;
  }
}
