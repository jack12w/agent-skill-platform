import { Controller, Post, Patch, Delete, Get, Body, UseGuards, Request, Param } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

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
}
