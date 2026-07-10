import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { UsersService } from './users.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @UseGuards(OptionalAuthGuard)
  @Get(':username')
  findOne(@Param('username') username: string, @Request() req?: any) {
    return this.usersService.findOne(username, req?.user?.sub);
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
