import Redis from 'ioredis';

/**
 * 微信 OAuth 的 CSRF state 存储。
 *
 * 背景：原先 state 存在模块级内存 Map 里，单容器部署侥幸可用，但一旦扩成多副本
 * （docker compose replicas / PM2 cluster），生成 state 的实例与处理回调的实例可能
 * 不是同一个，回调侧内存里查不到 → 登录大面积失败。
 *
 * 因此改为 Redis 为主存、进程内存为兜底：
 * - Redis 可用 → 跨实例共享，多副本安全
 * - Redis 不可用 → 退回内存，行为与改造前完全一致（不会比现在更差）
 * - 写入双写、读取 Redis 优先内存兜底 → Redis 中途抖动也能尽量救回
 *
 * 容错参数与 rate-limit.guard.ts / system-metrics.service.ts 保持一致，
 * 目的相同：Redis 出问题时降级，绝不阻塞登录主链路。
 */

/** state 有效期 5 分钟，与微信授权页的合理停留时间匹配 */
const TTL_SEC = 5 * 60;

/**
 * Lua：原子「读取并删除」，保证一个 state 只会被消费一次（防重放）。
 * 不用 Redis 6.2+ 的 GETDEL，是为了兼容更低版本的 Redis —— Lua 在所有版本都可用。
 */
const TAKE_AND_DELETE_LUA = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

/** Redis 惰性单例：直到第一次使用才连接，未配置 REDIS_URL 时直接走内存 */
let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }
  try {
    const client = new Redis(url, {
      lazyConnect: true, // 首次命令时才连接，不阻塞启动
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => null, // 连接失败后不再自动重连，直接降级内存兜底
    });
    // 连接级错误 → 丢弃该实例，后续请求走内存兜底
    client.on('error', () => {
      if (redisClient === client) redisClient = null;
    });
    redisClient = client;
    return client;
  } catch {
    redisClient = null;
    return null;
  }
}

/** 所有 store 实例，供统一清理内存兜底条目 */
const allStores: WechatStateStore<any>[] = [];

export class WechatStateStore<T extends object> {
  /** 内存兜底：key -> { value, expiresAt } */
  private readonly mem = new Map<string, { value: T; expiresAt: number }>();

  /** @param ns Redis key 命名空间，同时隔离不同用途的 state */
  constructor(private readonly ns: string) {
    allStores.push(this);
  }

  private key(state: string): string {
    return `${this.ns}:${state}`;
  }

  /**
   * 写入 state（带 TTL）。
   *
   * 注意：**不能**在 Redis 写成功后还顺手写一份内存。否则多副本下会出现重放漏洞 ——
   * 实例 A 写入（Redis + A 的内存），回调打到实例 B 由 Redis 消费成功，但 A 的内存残留
   * 没人清理；同一 state 再打到 A 时 Redis 已空，会回退命中 A 的内存残留，被二次消费。
   *
   * 因此这里二选一：Redis 写成功即返回，只有 Redis 不可用/写失败才落到内存兜底。
   */
  async put(state: string, value: T): Promise<void> {
    const k = this.key(state);
    const r = getRedis();
    if (r) {
      try {
        await r.set(k, JSON.stringify(value), 'EX', TTL_SEC);
        return;
      } catch {
        // Redis 写失败 → 落到下面的内存兜底
      }
    }
    this.mem.set(k, { value, expiresAt: Date.now() + TTL_SEC * 1000 });
  }

  /**
   * 消费 state：取到即删除，保证一个 state 只会被用一次。
   * 未命中返回 null（未签发 / 已过期 / 已被消费）。
   */
  async take(state: string): Promise<T | null> {
    const k = this.key(state);
    const r = getRedis();
    if (r) {
      try {
        const raw = (await r.eval(TAKE_AND_DELETE_LUA, 1, k)) as string | null;
        if (raw) {
          this.mem.delete(k); // Redis 侧已消费，清掉本实例的内存残留
          return JSON.parse(raw) as T;
        }
      } catch {
        // Redis 读失败 → 落到下面的内存兜底
      }
    }
    const hit = this.mem.get(k);
    if (!hit) return null;
    this.mem.delete(k); // 内存侧同样保证一次性
    return Date.now() > hit.expiresAt ? null : hit.value;
  }

  /** 清理内存兜底中的过期条目 */
  sweep(now: number): void {
    for (const [k, v] of this.mem) {
      if (v.expiresAt <= now) this.mem.delete(k);
    }
  }
}

// 内存兜底的过期清理（Redis 正常时这里基本是空的，开销可忽略）
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const s of allStores) s.sweep(now);
}, 600_000);
// 不阻止进程退出
if (typeof sweeper.unref === 'function') sweeper.unref();
