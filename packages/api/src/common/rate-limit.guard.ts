import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

/**
 * 基于 IP 的滑动窗口限流器（纯内存 Map，无需 Redis，适配 PM2 多进程：每进程独立计数）。
 *
 * 设计要点（针对「Docker/Next 反代下全站共享一个网桥 IP」导致的全员 429 事故）：
 * 1. 优先从 X-Forwarded-For 取原始客户端 IP（最左一跳），兼容 Nginx/Next 透传；
 *    若取不到真实客户端 IP（拿到的只是内网/网桥 IP），则**回退到全局大桶**，
 *    绝不让所有用户共用一个 120/分钟的小桶被瞬间打满。
 * 2. 真实客户端 IP：每 IP 每分钟默认 600 次（正常浏览/轮询远到不了，可挡住脚本/爬虫）。
 *    共享网桥 IP：全局默认 min(600*5, 2000) 次/分钟，足够正常聚合流量通过。
 * 3. 健康检查 /api/health 豁免，避免影响探针/监控。
 *
 * 如需跨进程精确限流，可后续替换为 Redis 版本（项目已依赖 ioredis，REDIS_URL 已配置）。
 */

const WINDOW_MS = 60_000;
/** 真实客户端 IP 时的单 IP 上限 */
const DEFAULT_MAX_PER_IP = 600;
/** 共享网桥 IP 时的全局上限 */
const DEFAULT_MAX_GLOBAL = Math.max(DEFAULT_MAX_PER_IP * 5, 2000);
/** 内网/保留段标识 key（所有拿不到真实客户端 IP 的请求共用） */
const GLOBAL_KEY = '__global_proxy__';

interface Window {
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
  private readonly store = new Map<string, Window>();
  private readonly maxPerIp: number;
  private readonly maxGlobal: number;

  constructor(maxPerIp = DEFAULT_MAX_PER_IP) {
    this.maxPerIp = maxPerIp;
    this.maxGlobal = Math.max(maxPerIp * 5, DEFAULT_MAX_GLOBAL);
    // 每 5 分钟清理过期记录，防止内存泄漏
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

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const url = (request.originalUrl || request.url || '') as string;

    // 健康检查豁免（探针/监控不应被限流）
    if (url.includes('/api/health')) return true;

    const { key, realClient } = this.resolveClientIp(request);
    const now = Date.now();

    // 拿不到真实客户端 IP → 用全局大桶，避免共享小桶被瞬间打满
    const bucketKey = realClient ? key : GLOBAL_KEY;
    const max = realClient ? this.maxPerIp : this.maxGlobal;

    let entry = this.store.get(bucketKey);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.store.set(bucketKey, entry);
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
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) this.store.delete(key);
    }
  }
}
