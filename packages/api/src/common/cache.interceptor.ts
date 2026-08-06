import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, of, from } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { createHash } from 'crypto';

/**
 * 热点只读 GET 接口的 Redis 响应缓存（扛 5000 在线的核心杠杆）。
 *
 * 安全约束（避免串号）：
 * - 仅缓存白名单内的公开 GET 接口（技能列表/详情/版本、榜单、分类、GEO feed）。
 * - 缓存 key 含「匿名 / 登录用户」隔离：登录用户按 Authorization 令牌哈希分桶，
 *   绝不把 A 用户的含个人字段（is_liked / has_update 等）响应透传给 B 用户。
 * - 无 Authorization 的匿名请求共享同一份缓存（公开浏览的主体流量）。
 * - Redis 不可用/未配置时直接放行（不缓存），绝不阻塞全站。
 * - 仅缓存成功响应，错误（404/5xx）不落缓存。
 */

const DEFAULT_TTL = 30;
/** 变化更慢的接口给更长 TTL */
const TTL_OVERRIDE: Record<string, number> = {
  '/api/leaderboard': 60,
  '/api/ai/feed': 60,
  '/api/tags/groups': 60,
};

/** 仅这些路径会被缓存；下载/评论/写操作等天然不匹配 → 安全 */
function isCacheable(path: string): boolean {
  if (path === '/api/skills') return true;
  if (path === '/api/leaderboard') return true;
  if (path === '/api/ai/feed') return true;
  if (path === '/api/tags/groups') return true;
  if (/^\/api\/skills\/[^/]+\/versions$/.test(path)) return true; // 版本列表
  if (/^\/api\/skills\/[^/]+$/.test(path)) return true; // 详情（单段 id，自动排除 download/comments）
  return false;
}

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private redis: Redis | null = null;

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      try {
        this.redis = new Redis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 1000,
          commandTimeout: 1000,
          retryStrategy: () => null, // 连接失败不再自动重连，直接降级为不缓存
        });
        this.redis.on('error', () => {
          this.redis = null;
        });
      } catch {
        this.redis = null;
      }
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    if (req.method !== 'GET') return next.handle();

    const url = (req.originalUrl || req.url || '') as string;
    const path = url.split('?')[0];
    if (!isCacheable(path)) return next.handle();

    const ttl = TTL_OVERRIDE[path] ?? DEFAULT_TTL;
    // 匿名共享 / 登录用户按令牌隔离，避免串号
    const auth = (req.headers.authorization as string | undefined) || '';
    const uid = auth
      ? 'u' + createHash('sha256').update(auth).digest('hex').slice(0, 16)
      : 'anon';
    const key = `cache:v1:${path}:${uid}`;

    if (!this.redis) return next.handle();

    return from(this.redis.get(key)).pipe(
      switchMap((cached) => {
        if (cached) {
          try {
            const data = JSON.parse(cached);
            res.setHeader('X-Cache', 'HIT');
            return of(data);
          } catch {
            // 解析失败当作未命中，继续走源站
          }
        }
        return next.handle().pipe(
          tap({
            next: (data) => {
              if (data !== undefined && data !== null) {
                this.redis?.set(key, JSON.stringify(data), 'EX', ttl).catch(() => {
                  /* 写入失败忽略，不影响响应 */
                });
              }
            },
          }),
        );
      }),
    );
  }
}
