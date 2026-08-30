import Redis from 'ioredis';

/**
 * 全局共享的 Redis 客户端（惰性单例）。
 *
 * 背景：原先每个用到 Redis 的模块各建一个连接（wechat-state.store、rate-limit.guard、
 * system-metrics.service 各一个），连接数随模块数量线性增长，且各写一套容错逻辑，
 * 行为不一致（有的永久降级、有的静默重试）。这里统一收敛成一个共享实例。
 *
 * 三条硬性设计：
 * 1. **惰性连接**：未配置 REDIS_URL 时直接返回 null，调用方走内存/降级路径，绝不阻塞启动。
 * 2. **失败冷却 + 自愈**：Redis 出故障时不永久放弃，而是标记一段冷却期（10s）后
 *    允许重新建连。这是修复「限流器抖一次就永久降级为内存计数、限流悄悄失效」的关键 ——
 *    旧实现里 `this.redis = null` 之后再也不会恢复。
 * 3. **故障共享**：任一模块报告故障即全局降级。Redis 挂了就是挂了，不存在「A 模块能用
 *    B 模块不能用」，统一降级比各模块自欺欺人更安全。
 *
 * 注意：这里**不设** `enableOfflineQueue: false`。lazyConnect 下第一次命令会触发建连，
 * 配合 offlineQueue=true 该命令才会排队等待连接建立；若为 false 则首条命令必失败。
 * 用 commandTimeout=1000ms 兜底，避免 Redis 卡死时拖住请求线程。
 */

/** 故障冷却时长：冷却期内直接返回 null（走降级），到期后允许重新建连探测 */
const FAIL_COOLDOWN_MS = 10_000;

let client: Redis | null = null;
/** 当前实例绑定的 URL —— 环境变量变化时重建，避免复用错实例 */
let clientUrl: string | null = null;
/** 冷却截止时间（ms epoch） */
let brokenUntil = 0;

function build(url: string): Redis | null {
  try {
    const c = new Redis(url, {
      lazyConnect: true, // 首次命令时才连接，不阻塞启动
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => null, // 连接失败后不自动重连，交给下面的冷却 + 惰性重建探测
    });
    // 连接级错误 → 全局降级（冷却结束后自动重试）
    c.on('error', () => reportRedisFailure(c));
    client = c;
    clientUrl = url;
    return c;
  } catch {
    brokenUntil = Date.now() + FAIL_COOLDOWN_MS;
    client = null;
    clientUrl = null;
    return null;
  }
}

/**
 * 取共享 Redis 实例；不可用（未配置 / 冷却中 / 建连失败）时返回 null。
 * 每次调用都返回当前有效实例 —— 调用方不要缓存返回值，否则会持有已废弃的连接。
 */
export function getSharedRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (client && clientUrl === url) return client;
  if (Date.now() < brokenUntil) return null;
  return build(url);
}

/**
 * 报告一次 Redis 故障：丢弃当前实例并进入冷却期，到期后自动重建。
 * @param c 出故障的实例；传 null/undefined 表示「未知实例，无条件降级」。
 *          传旧实例时若它已被换掉，则忽略（避免陈旧故障把新连接误杀）。
 */
export function reportRedisFailure(c?: Redis | null): void {
  if (c && c !== client) return; // 陈旧实例，与当前连接无关
  brokenUntil = Date.now() + FAIL_COOLDOWN_MS;
  const old = client;
  client = null;
  clientUrl = null;
  if (old) {
    try {
      old.disconnect();
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

/** 测试/运维用：强制重置共享实例（下次调用将重新建连） */
export function resetSharedRedisForTest(): void {
  const old = client;
  client = null;
  clientUrl = null;
  brokenUntil = 0;
  if (old) {
    try {
      old.disconnect();
    } catch {
      /* 忽略关闭异常 */
    }
  }
}
