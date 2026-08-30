import { getSharedRedis, reportRedisFailure } from './redis.client';

/**
 * 分布式互斥锁（单飞锁）—— 让定时任务在多副本下只跑一个实例。
 *
 * 为什么需要：后台定时任务是 `onModuleInit` 里的裸 `setInterval`，每个副本都会起一份。
 * 单容器部署没问题，一旦扩副本，同一批记录会被 N 个副本各处理一遍：
 * 微信查单/关单 API 调用放大 N 倍（有频限风险）、DB 写入放大 N 倍。
 *
 * 设计取舍：
 * - **只做「单飞」，不做严格互斥**：拿不到锁的副本直接跳过本轮，不排队等待。
 *   定时任务本来就允许「本轮不跑、下轮再跑」，没必要为它引入等待队列与惊群。
 * - **释放必须比对 token**：执行超时导致锁过期时，直接 DEL 会删掉别的副本刚拿到的锁。
 *   用 Lua 比对 token 再删（compare-and-delete），这是分布式锁最容易写错的一环。
 * - **Redis 不可用时的降级方向由调用方决定**：照跑（保持现状、功能不中断）
 *   还是跳过（更保守、转人工）。见 `run` 的 `onRedisDown`。
 * - **无阻塞**：命令 1s 超时（见 redis.client.ts），Redis 卡死不会拖住定时任务。
 */

/** Lua：仅当 value 等于 token 时才删除（compare-and-delete），返回是否真的删了 */
const RELEASE_IF_MATCH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/** Redis 不可用时本轮怎么办 */
export type LockFallback = 'run' | 'skip';

/** 获取锁的结果：`{token}` 拿到了 / `{redisDown:true}` Redis 不可用 / `null` 被别的副本持有 */
type AcquireResult = { token: string } | { redisDown: true } | null;

export class DistributedLock {
  constructor(private readonly key: string) {}

  /**
   * 尝试获取锁。
   *
   * 必须区分「锁被占用」和「Redis 不可用」两种失败：前者是正常的单飞跳过，
   * 后者要按调用方的降级策略决定照跑还是跳过 —— 混为一谈会让 Redis 故障时
   * 定时任务静默停摆（Redis 命令抛错的当次尚未进入冷却，getSharedRedis() 仍返回客户端）。
   *
   * @param ttlSec 租约时长，必须大于任务正常执行耗时，小于任务周期。
   */
  async acquire(ttlSec: number): Promise<AcquireResult> {
    const r = getSharedRedis();
    if (!r) return { redisDown: true };
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = await r.set(this.key, token, 'EX', ttlSec, 'NX');
      return res === 'OK' ? { token } : null;
    } catch {
      reportRedisFailure(r);
      return { redisDown: true };
    }
  }

  /** 释放锁：仅当锁仍由自己持有时才删除 */
  async release(token: string): Promise<void> {
    const r = getSharedRedis();
    if (!r) return;
    try {
      await r.eval(RELEASE_IF_MATCH_LUA, 1, this.key, token);
    } catch {
      reportRedisFailure(r);
    }
  }

  /**
   * 单飞执行：拿到锁才跑 `fn`，跑完（无论成功失败）释放。
   *
   * @param ttlSec      租约时长
   * @param fn          实际任务
   * @param onRedisDown Redis 不可用时：'run' 照跑（默认，保持与改造前一致、功能不中断），
   *                    'skip' 跳过本轮（更保守，适用于重复跑有资金风险的任务）
   * @returns ran 本轮是否真的执行了；degraded 是否因 Redis 不可用而走了降级路径
   */
  async run<T>(
    ttlSec: number,
    fn: () => Promise<T>,
    onRedisDown: LockFallback = 'run',
  ): Promise<{ ran: boolean; degraded: boolean; result?: T }> {
    const acq = await this.acquire(ttlSec);

    if (acq && 'token' in acq) {
      try {
        return { ran: true, degraded: false, result: await fn() };
      } finally {
        await this.release(acq.token);
      }
    }

    const degraded = acq !== null; // {redisDown:true} → Redis 不可用；null → 别的副本在跑
    if (degraded && onRedisDown === 'run') {
      return { ran: true, degraded: true, result: await fn() };
    }
    return { ran: false, degraded };
  }
}
