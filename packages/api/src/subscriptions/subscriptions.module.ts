import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController, NotificationsController } from './subscriptions.controller';
import { Subscription } from './subscription.entity';
import { Notification } from './notification.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Notification, User, Team]),
    CommonModule,
    AuthModule,
  ],
  providers: [SubscriptionsService],
  controllers: [SubscriptionsController, NotificationsController],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
