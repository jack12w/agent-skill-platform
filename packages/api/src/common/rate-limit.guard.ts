import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

/**
 * 基于 IP 的滑动窗口限流器。
 *
 * 默认：每个 IP 每分钟最多 60 次请求。
 * 超过限制返回 429 Too Many Requests。
 *
 * 使用纯内存 Map，无需 Redis。适合单机/PM2 集群（每进程独立计数）。
 * 如果需要跨进程精确限流，可替换为 Redis 版本。
 */

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly store = new Map<string, Window>();
  private readonly windowMs: number;
  private readonly max: number;

  /** @param windowMs 时间窗口（毫秒），默认 60000（1 分钟） */
  /** @param max 窗口内最大请求数，默认 60 */
  constructor(windowMs = 60_000, max = 60) {
    this.windowMs = windowMs;
    this.max = max;
    // 每 5 分钟清理过期记录，防止内存泄漏
    setInterval(() => this.cleanup(), 300_000);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const ip = request.ip || request.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = this.store.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.store.set(ip, entry);
    }

    entry.count++;

    if (entry.count > this.max) {
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
