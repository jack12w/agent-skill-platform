import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamsService } from './teams.service';
import { TeamsController } from './teams.controller';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { Skill } from '../skills/skill.entity';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Team, TeamMember, Skill]),
  ],
  providers: [TeamsService, OptionalAuthGuard],
  controllers: [TeamsController],
  exports: [TeamsService],
})
export class TeamsModule {}
