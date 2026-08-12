import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MailQueueService } from './mail-queue.service';
import Redis from 'ioredis';
import os from 'os';

/** 东八区（中国）偏移毫秒 */
const CN_OFFSET_MS = 8 * 3600 * 1000;

/** 把任意时刻按东八区（北京时间）解释：返回的 Date 其 getHours()/getDate() 等为北京时间。
 *  无论容器时区是 UTC 还是 Asia/Shanghai，指标统计都统一按中国时间，
 *  避免「今天」和 5 分钟槽位因时区错位（典型：容器 UTC 导致比北京慢 8h，曲线只画到下午 3 点）。 */
function cnNow(base: Date = new Date()): Date {
  // local 时区下 getTimezoneOffset() 为「本地→UTC 需加的分钟数」；转东八区 = 先回 UTC 再 +8h。
  return new Date(base.getTime() + base.getTimezoneOffset() * 60000 + CN_OFFSET_MS);
}

/** 本地（中国）日期 YYYY-MM-DD（用于每日聚合 key） */
function ymd(d: Date = new Date()): string {
  const c = cnNow(d);
  const y = c.getFullYear();
  const m = String(c.getMonth() + 1).padStart(2, '0');
  const day = String(c.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 全天 5 分钟一档 = 288 槽 */
const TODAY_SLOTS = 288;

/**
 * 轻量系统指标收集（用于管理后台「系统设置」展示）。
 * - 请求计数：每收到一个 API 请求调用 recordRequest()，维护滑动窗口算 QPS / 每分钟。
 * - 并发计数：incInFlight()/decInFlight() 在请求开始 / 结束时调用，统计当前在飞请求数（inFlight）
 *   与今日并发峰值（peakInFlight）；并在每个 5 分钟槽记录并发峰值，用于「今日并发走势」。
 * - 当天曲线：todayReq / todayConc 两个 288 槽数组，从 00:00 起每 5 分钟累计，用于「今日请求走势」。
 * - 进程/系统采样：内存占用、系统负载。
 * - 依赖外部：通过 DataSource 查 pg_stat_activity 取 DB 活动连接；
 *   通过 MailQueueService 取 Bull 邮件队列积压（未用 Redis 时为 null）。
 * - 持久化：每分钟聚合值写入 Redis（ZSET metrics:reqpermin），服务重启时回填，避免「重启归零」；
 *   当天曲线与并发峰值写入 Redis Hash（metrics:today:req / metrics:today:conc / metrics:peak），
 *   重启时回填 todayReq / todayConc / peakInFlight。
 *   实时 QPS（秒级）与 inFlight（当前在飞）走内存、重启自愈，不落盘（瞬时值无意义持久化）。
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

  // ── 并发 & 当天曲线（inFlight/peak 走内存，当天曲线 Redis 持久化）──
  private inFlight = 0; // 当前在飞请求数（Node 单线程，++/-- 天然原子）
  private peakInFlight = 0; // 今日并发峰值
  private todayDate = ymd(new Date());
  private todayReq = new Array<number>(TODAY_SLOTS).fill(0); // 当天每 5 分钟请求数
  private todayConc = new Array<number>(TODAY_SLOTS).fill(0); // 当天每 5 分钟并发峰值

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

  /** 启动回填：从 Redis 读回最近 N 分钟 + 当天曲线 + 并发峰值，避免重启后面板归零/空白 */
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

      // 回填当天曲线 + 并发峰值
      const today = ymd(new Date());
      const reqHash = await this.redis.hgetall(`metrics:today:req:${today}`);
      const concHash = await this.redis.hgetall(`metrics:today:conc:${today}`);
      for (const [k, v] of Object.entries(reqHash)) {
        const idx = Number(k);
        if (idx >= 0 && idx < TODAY_SLOTS) this.todayReq[idx] = Number(v) || 0;
      }
      for (const [k, v] of Object.entries(concHash)) {
        const idx = Number(k);
        if (idx >= 0 && idx < TODAY_SLOTS) this.todayConc[idx] = Number(v) || 0;
      }
      const peakRaw = await this.redis.get(`metrics:peak:${today}`);
      this.peakInFlight = peakRaw ? Number(peakRaw) || 0 : 0;
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
    // 当天请求曲线
    this.bumpTodayReq();
  }

  /** 请求进入时调用：当前在飞 +1，更新并发峰值与当前 5 分钟槽的并发峰值 */
  incInFlight(): void {
    this.ensureToday();
    this.inFlight++;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    const slot = this.slotIndex();
    if (slot >= 0 && slot < TODAY_SLOTS && this.inFlight > this.todayConc[slot]) {
      this.todayConc[slot] = this.inFlight;
    }
  }

  /** 请求结束时调用：当前在飞 -1（不会减到负数） */
  decInFlight(): void {
    if (this.inFlight > 0) this.inFlight--;
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
      // 当天曲线 + 并发峰值落盘
      void this.persistToday(this.todayDate, this.todayReq, this.todayConc, this.peakInFlight);
    } catch {
      /* 静默降级 */
    }
  }

  /** 把当天曲线（请求 / 并发）与并发峰值写入 Redis；服务重启后可回填 */
  private async persistToday(
    date: string,
    req: number[],
    conc: number[],
    peak: number,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const reqKey = `metrics:today:req:${date}`;
      const concKey = `metrics:today:conc:${date}`;
      const reqArgs: (string | number)[] = [];
      const concArgs: (string | number)[] = [];
      for (let i = 0; i < req.length; i++) {
        if (req[i] > 0) reqArgs.push(i, req[i]);
      }
      for (let i = 0; i < conc.length; i++) {
        if (conc[i] > 0) concArgs.push(i, conc[i]);
      }
      if (reqArgs.length) {
        await this.redis.hset(reqKey, ...reqArgs);
        await this.redis.expire(reqKey, 2 * 24 * 3600);
      }
      if (concArgs.length) {
        await this.redis.hset(concKey, ...concArgs);
        await this.redis.expire(concKey, 2 * 24 * 3600);
      }
      await this.redis.set(`metrics:peak:${date}`, peak, 'EX', 2 * 24 * 3600);
    } catch {
      /* 静默降级 */
    }
  }

  /** 当天 00:00 起的第几个 5 分钟槽（0..287），越界则夹紧（按东八区计算） */
  private slotIndex(ts = Date.now()): number {
    const d = cnNow(new Date(ts));
    const secOfDay = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    return Math.max(0, Math.min(TODAY_SLOTS - 1, Math.floor(secOfDay / 300)));
  }

  /** 跨天：先持久化旧的一天，再重置当天数组与并发峰值 */
  private ensureToday(): void {
    const today = ymd(new Date());
    if (today !== this.todayDate) {
      void this.persistToday(this.todayDate, this.todayReq, this.todayConc, this.peakInFlight);
      this.todayDate = today;
      this.todayReq = new Array<number>(TODAY_SLOTS).fill(0);
      this.todayConc = new Array<number>(TODAY_SLOTS).fill(0);
      this.peakInFlight = 0;
    }
  }

  private bumpTodayReq(): void {
    this.ensureToday();
    const slot = this.slotIndex();
    if (slot >= 0 && slot < TODAY_SLOTS) this.todayReq[slot]++;
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

    // 当天曲线只取到「当前槽」，避免画出未来的空点
    const slotNow = this.slotIndex();
    const todayRequests = this.todayReq.slice(0, slotNow + 1);
    const todayConcurrency = this.todayConc.slice(0, slotNow + 1);

    // 当天 00:00（按东八区本地天）对应的 UTC 毫秒：供前端按用户时区格式化横轴标签。
    // 桶边界仍按本地天计算（否则「今日」只覆盖半个北京天）；展示时由前端将此时刻转本地时区。
    const day0 = cnNow(new Date());
    day0.setHours(0, 0, 0, 0);
    const todayStartTs = day0.getTime();

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
        inFlight: this.inFlight,
        peakInFlightToday: this.peakInFlight,
        todayDate: this.todayDate,
        todayStartTs,
        todayRequests,
        todayConcurrency,
      },
      database: { activeConnections: dbConnections },
      mailQueue,
    };
  }
}
