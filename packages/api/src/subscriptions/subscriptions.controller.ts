import { Controller, Post, Delete, Get, Query, Body, Request, UseGuards, ParseEnumPipe } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { AuthGuard } from '../auth/auth.guard';
import { SubscriptionTargetType } from './subscription.entity';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private svc: SubscriptionsService) {}

  @UseGuards(AuthGuard)
  @Post()
  subscribe(
    @Request() req: any,
    @Body() body: { targetType: SubscriptionTargetType; targetId: string },
  ) {
    return this.svc.subscribe(req.user.sub, body.targetType, body.targetId);
  }

  @UseGuards(AuthGuard)
  @Delete()
  unsubscribe(
    @Request() req: any,
    @Query('targetType', new ParseEnumPipe(['user', 'team'])) targetType: SubscriptionTargetType,
    @Query('targetId') targetId: string,
  ) {
    return this.svc.unsubscribe(req.user.sub, targetType, targetId);
  }

  @UseGuards(AuthGuard)
  @Get('status')
  status(
    @Request() req: any,
    @Query('targetType', new ParseEnumPipe(['user', 'team'])) targetType: SubscriptionTargetType,
    @Query('targetId') targetId: string,
  ) {
    return this.svc.getStatus(req.user.sub, targetType, targetId);
  }

  @Get('count')
  count(
    @Query('targetType', new ParseEnumPipe(['user', 'team'])) targetType: SubscriptionTargetType,
    @Query('targetId') targetId: string,
  ) {
    return this.svc.count(targetType, targetId);
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private svc: SubscriptionsService) {}

  @UseGuards(AuthGuard)
  @Get()
  list(@Request() req: any) {
    return this.svc.listNotifications(req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Post('read')
  markRead(@Request() req: any, @Body() body: { id?: string }) {
    return this.svc.markRead(req.user.sub, body?.id);
  }
}
