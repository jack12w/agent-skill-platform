import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MailQueueService } from './mail-queue.service';
import os from 'os';

/**
 * 轻量系统指标收集（用于管理后台「系统设置」展示）。
 * - 请求计数：每收到一个 API 请求调用 recordRequest()，维护滑动窗口算 QPS / 每分钟。
 * - 进程/系统采样：内存占用、系统负载。
 * - 依赖外部：通过 DataSource 查 pg_stat_activity 取 DB 活动连接；
 *   通过 MailQueueService 取 Bull 邮件队列积压（未用 Redis 时为 null）。
 * 只读、无副作用，失败均吞掉返回 null，不影响主流程。
 */
@Injectable()
export class SystemMetricsService {
  private totalRequests = 0;
  private windowStart = Date.now();
  private windowRequests = 0;
  private lastPerMinute = 0;

  // 60 个 1 秒桶，用于计算滑动平均 QPS
  private readonly buckets = new Array<number>(60).fill(0);
  private bucketIdx = 0;
  private lastBucketTs = Date.now();

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailQueue: MailQueueService,
  ) {}

  /** 每收到一个 API 请求调用一次（由 main.ts 全局中间件触发） */
  recordRequest(): void {
    this.totalRequests++;
    this.windowRequests++;
    const now = Date.now();
    if (now - this.lastBucketTs >= 1000) {
      this.lastBucketTs = now;
      this.bucketIdx = (this.bucketIdx + 1) % this.buckets.length;
      this.buckets[this.bucketIdx] = 0;
    }
    this.buckets[this.bucketIdx]++;
    if (now - this.windowStart >= 60_000) {
      this.lastPerMinute = this.windowRequests;
      this.windowRequests = 0;
      this.windowStart = now;
    }
  }

  async getMetrics() {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const cpuCores = os.cpus().length;

    let dbConnections: number | null = null;
    try {
      const rows = await this.dataSource.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity',
      );
      dbConnections = rows[0]?.n ?? null;
    } catch {
      dbConnections = null;
    }

    let mailQueue: Record<string, number> | null = null;
    try {
      mailQueue = await this.mailQueue.getQueueCounts();
    } catch {
      mailQueue = null;
    }

    const perSecond =
      this.buckets.reduce((sum, n) => sum + n, 0) / this.buckets.length;

    return {
      timestamp: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        memoryRssMb: Math.round(mem.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        memoryHeapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      system: {
        loadavg1: Number(load[0].toFixed(2)),
        cpuCores,
        platform: os.platform(),
      },
      requests: {
        total: this.totalRequests,
        perMinute: this.lastPerMinute,
        perSecond: Number(perSecond.toFixed(2)),
      },
      database: { activeConnections: dbConnections },
      mailQueue,
    };
  }
}
