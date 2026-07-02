import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '../auth/user.entity';
import { Skill } from '../skills/skill.entity';
import { SkillsModule } from '../skills/skills.module';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Skill]),
    SkillsModule,
  ],
  providers: [UsersService, OptionalAuthGuard],
  controllers: [UsersController],
})
export class UsersModule {}
