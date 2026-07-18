import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MailQueueService } from './mail-queue.service';
import Redis from 'ioredis';
import os from 'os';

/** 本地日期 YYYY-MM-DD（用于每日聚合 key） */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 轻量系统指标收集（用于管理后台「系统设置」展示）。
 * - 请求计数：每收到一个 API 请求调用 recordRequest()，维护滑动窗口算 QPS / 每分钟。
 * - 进程/系统采样：内存占用、系统负载。
 * - 依赖外部：通过 DataSource 查 pg_stat_activity 取 DB 活动连接；
 *   通过 MailQueueService 取 Bull 邮件队列积压（未用 Redis 时为 null）。
 * - 持久化：每分钟聚合值写入 Redis（ZSET metrics:reqpermin），服务重启时回填，避免「重启归零」。
 *   实时 QPS（秒级）走内存桶、重启自愈，不落盘。
 * 只读、无副作用，失败均吞掉返回 null，不影响主流程；REDIS_URL 缺失时自动降级（不持久化）。
 */
@Injectable()
export class SystemMetricsService implements OnModuleInit {
  private totalRequests = 0;
  private windowStart = Date.now();
  private windowRequests = 0;
  private lastPerMinute = 0;

  // 60 个 1 秒桶，用于计算滑动平均 QPS
  private readonly buckets = new Array<number>(60).fill(0);
  private bucketIdx = 0;
  private lastBucketTs = Date.now();

  // Redis 持久化（每分钟请求数历史），REDIS_URL 缺失则为 null（降级）
  private redis: Redis | null = null;
  private readonly redisKey = 'metrics:reqpermin';
  private readonly historyMinutes = 60;

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailQueue: MailQueueService,
  ) {
    const url = process.env.REDIS_URL;
    if (url) {
      try {
        // retryStrategy 返回 null → 连不上立即停止重连，避免阻塞；enableOfflineQueue 关闭离线堆积
        this.redis = new Redis(url, {
          retryStrategy: () => null,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: true,
        });
        this.redis.on('error', () => {
          /* 静默降级：持久化失败不影响主流程 */
        });
      } catch {
        this.redis = null;
      }
    }
  }

  /** 启动回填：从 Redis 读回最近 N 分钟，避免重启后面板归零/空白 */
  async onModuleInit() {
    if (!this.redis) return;
    try {
      await this.redis.connect();
    } catch {
      this.redis = null;
      return;
    }
    try {
      const cutoff = Date.now() - this.historyMinutes * 60_000;
      const raw = await this.redis.zrangebyscore(
        this.redisKey,
        cutoff,
        '+inf',
        'WITHSCORES',
      );
      // raw: [member, score, member, score, ...]，member=计数，score=分钟时间戳(ms)
      const hist: { ts: number; count: number }[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        hist.push({ ts: Number(raw[i + 1]), count: Number(raw[i]) });
      }
      if (hist.length) {
        // 用最近一分钟的历史值作为初始 lastPerMinute，避免首屏显示 0
        this.lastPerMinute = hist[hist.length - 1].count;
      }
    } catch {
      /* 静默降级 */
    }
  }

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
      // 异步持久化到 Redis（不阻塞请求处理）
      void this.persistPerMinute(this.lastPerMinute);
    }
  }

  /** 把某一分钟的请求数写入 Redis，并清理旧数据 */
  private async persistPerMinute(count: number): Promise<void> {
    if (!this.redis) return;
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    try {
      await this.redis.zadd(this.redisKey, minute, String(count));
      const cutoff = minute - this.historyMinutes * 60_000;
      await this.redis.zremrangebyscore(this.redisKey, '-inf', cutoff);
      // 每日累计（用于 7 天曲线），30 天过期自动清理
      const dayKey = `metrics:reqperday:${ymd(new Date())}`;
      await this.redis.incrby(dayKey, count);
      await this.redis.expire(dayKey, 30 * 24 * 3600);
    } catch {
      /* 静默降级 */
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

    // 从 Redis 读历史曲线（无 Redis 时为 null，前端不渲染）
    let history: { ts: number; count: number }[] | null = null;
    let dailyHistory: { date: string; count: number }[] | null = null;
    if (this.redis) {
      try {
        const cutoff = Date.now() - this.historyMinutes * 60_000;
        const raw = await this.redis.zrangebyscore(
          this.redisKey,
          cutoff,
          '+inf',
          'WITHSCORES',
        );
        history = [];
        for (let i = 0; i < raw.length; i += 2) {
          history.push({ ts: Number(raw[i + 1]), count: Number(raw[i]) });
        }
        dailyHistory = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 24 * 3600 * 1000);
          const c = await this.redis.get(`metrics:reqperday:${ymd(d)}`);
          dailyHistory.push({ date: ymd(d), count: Number(c) || 0 });
        }
      } catch {
        history = null;
        dailyHistory = null;
      }
    }

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
        history,
        dailyHistory,
      },
      database: { activeConnections: dbConnections },
      mailQueue,
    };
  }
}
