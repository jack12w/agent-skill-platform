import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { MailQueueService } from './mail-queue.service';
import { SystemMetricsService } from './system-metrics.service';

@Module({
  providers: [EmailService, MailQueueService, SystemMetricsService],
  exports: [EmailService, MailQueueService, SystemMetricsService],
})
export class CommonModule {}
