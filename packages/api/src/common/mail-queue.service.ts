import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import Queue from 'bull';

export interface MailJob {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * 统一邮件队列（Bull + Redis）。
 * - 配置 REDIS_URL 时：邮件任务入队，由进程内 worker 异步消费，
 *   具备持久化、失败自动重试（指数退避）、并发可控（OTP 3 / 通知 5）。
 * - 未配置 REDIS_URL 或 Redis 连接失败时：自动回退为内联发送
 *   （复用 EmailService 及其连接池），保证线上邮件 / 验证码不中断。
 */
@Injectable()
export class MailQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MailQueueService.name);
  private queue: Queue.Queue | null = null;

  constructor(private readonly emailService: EmailService) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.warn('未配置 REDIS_URL，邮件将以内联方式发送（无队列持久化 / 重试）');
      return;
    }
    try {
      this.queue = new Queue('mail', {
        redis: redisUrl,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 2000,
        },
      });
      // Redis 连接异常时降级为内联发送，不阻塞应用
      this.queue.on('error', (err: any) => {
        this.logger.error(`Redis 连接错误，降级为内联发送: ${err?.message || err}`);
        this.queue = null;
      });
      // 进程内 worker 消费任务（并发受限，避免打爆 QQ SMTP）
      this.queue.process('otp', 3, (job) => this.emailService.sendMail(job.data as MailJob));
      this.queue.process('notification', 5, (job) => this.emailService.sendMail(job.data as MailJob));
      this.logger.log('已连接 Redis，邮件任务将入队异步处理');
    } catch (err: any) {
      this.logger.error(`队列初始化失败，降级为内联发送: ${err?.message || err}`);
      this.queue = null;
    }
  }

  /** OTP 验证码邮件：入队或回退内联（fire-and-forget） */
  sendOtp(email: string, code: string): void {
    const job: MailJob = {
      to: email,
      subject: 'SkillDepot - 邮箱验证码',
      text: `您的验证码是：${code}，10 分钟内有效。`,
    };
    if (this.queue) {
      this.queue
        .add('otp', job, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
        .catch((e) => this.fallback(job, e));
      return;
    }
    void this.fallback(job, null);
  }

  /** 批量订阅邮件：入队或回退内联并发发送 */
  sendBulk(jobs: MailJob[]): Promise<void[]> {
    if (this.queue) {
      return Promise.all(
        jobs.map((job) =>
          this.queue!
            .add('notification', job, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
            .then(() => undefined)
            .catch((e) => this.fallback(job, e)),
        ),
      );
    }
    return Promise.all(jobs.map((job) => this.fallback(job, null)));
  }

  private async fallback(job: MailJob, e: any): Promise<void> {
    if (e) this.logger.error(`入队失败，改内联发送: ${e?.message || e}`);
    await this.emailService.sendMail(job);
  }

  /** 返回队列任务计数（waiting/active/delayed/failed），未使用 Redis 时返回 null */
  async getQueueCounts(): Promise<Record<string, number> | null> {
    const q = this.queue as any;
    if (q && typeof q.getJobCounts === 'function') {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      return counts as Record<string, number>;
    }
    return null;
  }

  async onModuleDestroy() {
    if (this.queue) await this.queue.close();
  }
}
