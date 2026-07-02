import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { UsersService } from './users.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get(':username')
  findOne(@Param('username') username: string) {
    return this.usersService.findOne(username);
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':username/skills')
  findSkills(
    @Param('username') username: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Request() req?: any,
  ) {
    return this.usersService.findUserSkills(username, {
      page: page ? parseInt(page, 10) : 1,
      size: size ? parseInt(size, 10) : 20,
      currentUserId: req?.user?.sub,
    });
  }
}
