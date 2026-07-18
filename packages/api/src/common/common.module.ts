import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { MailQueueService } from './mail-queue.service';

@Module({
  providers: [EmailService, MailQueueService],
  exports: [EmailService, MailQueueService],
})
export class CommonModule {}
