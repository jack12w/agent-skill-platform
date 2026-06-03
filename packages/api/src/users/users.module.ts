import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '../auth/user.entity';
import { Skill } from '../skills/skill.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Skill]),
  ],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
