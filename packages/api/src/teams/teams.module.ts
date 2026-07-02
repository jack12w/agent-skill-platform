import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamsService } from './teams.service';
import { TeamsController } from './teams.controller';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { Skill } from '../skills/skill.entity';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { SkillsModule } from '../skills/skills.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Team, TeamMember, Skill]),
    SkillsModule,
  ],
  providers: [TeamsService, OptionalAuthGuard],
  controllers: [TeamsController],
  exports: [TeamsService],
})
export class TeamsModule {}
