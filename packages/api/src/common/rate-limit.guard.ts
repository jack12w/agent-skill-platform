import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * 基于 IP 的滑动窗口限流器 —— Redis 版（跨进程共享计数，按真实客户端 IP 精确限流）。
 *
 * 设计要点（针对「Docker/Next 反代下全站共享一个网桥 IP」导致的全员 429 事故 + 5000 在线目标）：
 * 1. 优先从 X-Forwarded-For 取原始客户端 IP（最左一跳），兼容 Nginx/Next 透传；
 *    若取不到真实客户端 IP（拿到的只是内网/网桥 IP），则**回退到全局大桶**，
 *    绝不让所有用户共用一个小桶被瞬间打满（多见于 XFF 未端到端透传的过渡期）。
 * 2. 真实客户端 IP：每 IP 每分钟 120 次（正常浏览/轮询远到不了，可挡住脚本/爬虫）。
 *    共享网桥 IP：全局 2000 次/分钟，足够正常聚合流量通过。
 * 3. Redis 跨进程共享计数，PM2 多实例计数一致；Redis 不可用/未配置时**降级内存兜底**，
 *    绝不因此阻塞全站。
 * 4. 健康检查 /api/health 豁免，避免影响探针/监控。
 */

const WINDOW_MS = 60_000;
/** 真实客户端 IP 时的单 IP 上限 */
const DEFAULT_MAX_PER_IP = 120;
/** 共享网桥 IP 时的全局上限 */
const DEFAULT_MAX_GLOBAL = Math.max(DEFAULT_MAX_PER_IP * 5, 2000);
/** 内网/保留段标识 key（所有拿不到真实客户端 IP 的请求共用） */
const GLOBAL_KEY = '__global_proxy__';

/**
 * 只读 GET 白名单 —— 这些接口幂等、服务端已缓存（leaderboard 60s / skills 30s 等）、成本极低，
 * 且是 SPA 每次路由变化都会触发的请求（jssdk / subscriptions/count / leaderboard / skills / tags/groups …）。
 * 正常浏览会在 1 分钟内密集触发，若纳入 per-IP 120 限制极易被误伤 429。
 * 因此对这些「GET + 白名单前缀」的请求完全放行（不参与限流计数），
 * 其余未知 GET / 所有写操作仍按 120/分钟（真实 IP）或 2000/分钟（全局）拦截，仍能挡爬虫/脚本。
 */
const READONLY_WHITELIST = [
  '/api/wechat/jssdk', // 微信分享签名：每次路由变化触发，仅微信内浏览器才生效
  '/api/subscriptions/count', // 订阅计数 badge：只读展示，订阅/取消是别的写接口
  '/api/leaderboard', // 排行榜：服务端 60s 缓存
  '/api/skills', // 技能列表/详情/版本：服务端 30s 缓存
  '/api/tags/groups', // 标签分组：几乎静态
  '/api/ai/feed', // AI feed：服务端 60s 缓存
];

/** 是否命中只读白名单（仅 GET/HEAD，写操作一律不豁免） */
function isReadonlyWhitelisted(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return READONLY_WHITELIST.some((p) => path === p || path.startsWith(p + '/'));
}

interface MemWindow {
  count: number;
  resetAt: number;
}

/** 判断是否为内网/回环/链路本地地址（说明 X-Forwarded-For 未正确透传，看到的是反代/网桥 IP） */
function isPrivateOrInternalIp(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // IPv6 等非 IPv4 → 当作公网处理
  const a = +m[1];
  const b = +m[2];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
  return false;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private redis: Redis | null = null;
  private readonly maxPerIp: number;
  private readonly maxGlobal: number;
  /** 内存兜底（仅当 Redis 不可用/未配置时启用，按进程计数，尽力而为） */
  private readonly memStore = new Map<string, MemWindow>();
  private readonly windowSec = Math.ceil(WINDOW_MS / 1000);

  constructor(maxPerIp = DEFAULT_MAX_PER_IP) {
    this.maxPerIp = maxPerIp;
    this.maxGlobal = Math.max(maxPerIp * 5, DEFAULT_MAX_GLOBAL);

    const url = process.env.REDIS_URL;
    if (url) {
      try {
        this.redis = new Redis(url, {
          lazyConnect: true, // 首次命令时才连接，不阻塞启动
          maxRetriesPerRequest: 1,
          connectTimeout: 1000,
          commandTimeout: 1000,
          retryStrategy: () => null, // 连接失败后不再自动重连，直接降级内存兜底
        });
        // 连接级错误 → 丢弃 Redis，后续请求走内存兜底，绝不阻塞全站
        this.redis.on('error', () => {
          this.redis = null;
        });
      } catch {
        this.redis = null;
      }
    }

    // 内存兜底过期清理，防止泄漏（仅兜底路径使用）
    setInterval(() => this.cleanup(), 300_000);
  }

  /**
   * 解析真实客户端 IP。
   * 优先读取 X-Forwarded-For（首跳 = 原始浏览器 IP），失败再退回 req.ip / remoteAddress。
   */
  private resolveClientIp(request: any): { key: string; realClient: boolean } {
    const xff = request.headers?.['x-forwarded-for'];
    if (xff) {
      const raw = Array.isArray(xff) ? xff[0] : xff;
      const first = String(raw).split(',')[0]?.trim();
      if (first) {
        return { key: first, realClient: !isPrivateOrInternalIp(first) };
      }
    }
    const ip = request.ip || request.connection?.remoteAddress || 'unknown';
    return { key: ip, realClient: !isPrivateOrInternalIp(ip) };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const rawUrl = (request.originalUrl || request.url || '') as string;
    const path = rawUrl.split('?')[0]; // 去掉 query，用于前缀白名单匹配

    // 健康检查豁免（探针/监控不应被限流）
    if (path.includes('/api/health')) return true;

    // 只读 GET 白名单：正常浏览密集触发的幂等只读接口，完全放行不参与限流计数。
    // 仅 GET/HEAD 命中；POST/PATCH/DELETE 等写操作不受影响，仍受 120/分钟拦截。
    if (isReadonlyWhitelisted(request.method, path)) return true;

    const { key, realClient } = this.resolveClientIp(request);
    // 真实客户端 IP → 精确限流；拿不到真实 IP → 全局大桶兜底
    const bucketKey = realClient ? `rl:ip:${key}` : GLOBAL_KEY;
    const max = realClient ? this.maxPerIp : this.maxGlobal;

    if (this.redis) {
      try {
        const count = await this.redis.incr(bucketKey);
        // 首条记录写入时设定窗口 TTL
        if (count === 1) {
          await this.redis.expire(bucketKey, this.windowSec);
        }
        if (count > max) {
          const ttl = await this.redis.ttl(bucketKey);
          const retryAfter = ttl > 0 ? ttl : this.windowSec;
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              message: `Too many requests. Retry after ${retryAfter}s.`,
              retryAfter,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return true;
      } catch (err) {
        // Redis 命令层面的限流异常需原样抛出；其它 Redis 异常降级内存兜底
        if (err instanceof HttpException) throw err;
        // 连接/超时错误 → 标记降级（下次直接走内存），本条请求用内存兜底放行判断
        this.redis = null;
      }
    }

    // ── 内存兜底（Redis 不可用/未配置时） ──
    return this.memAllow(bucketKey, max);
  }

  /** 内存兜底：按进程独立计数（不完善但保证不阻塞全站） */
  private memAllow(bucketKey: string, max: number): boolean {
    const now = Date.now();
    let entry = this.memStore.get(bucketKey);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.memStore.set(bucketKey, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many requests. Retry after ${retryAfter}s.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.memStore) {
      if (now > entry.resetAt) this.memStore.delete(key);
    }
  }
}
