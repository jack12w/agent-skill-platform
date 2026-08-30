import { getSharedRedis, reportRedisFailure } from './redis.client';

/**
 * 分布式进程状态存储：计数 / 标记 / 字符串值，Redis 为主存、进程内存为兜底。
 *
 * 用途：把散落在各 service 里的「模块级 Map/Set」迁到 Redis，让多副本（docker compose
 * replicas / PM2 cluster）共享同一份状态。原先这些状态只存在于单个进程的内存里，多副本时
 * 每个副本各算各的，表现为：限流/爆破防护被稀释 N 倍、资金安全闸永远攒不够次数、
 * 告警重复、后台任务链重复启动。
 *
 * 语义保证：
 * - **固定窗口计数**：`incr` 只有首次写入时设 TTL，后续自增不续期，与「首次失败后 10 分钟
 *   窗口」这类语义一致（滑动窗口会让持续攻击者永远出不了窗口，不符合原设计）。
 * - **失败方向必须是安全的**：Redis 不可用时退回内存，行为与改造前完全一致（不会更差）。
 *   对资金类调用方而言，Redis 挂掉 = 计数丢失 = 闸门不触发 = 转人工，**绝不会误放行**。
 * - **无阻塞**：所有命令 1s 超时（见 redis.client.ts），Redis 卡死时不会拖住请求。
 *
 * 不做的事：不做分布式锁。这里的场景（计数、去重标记）用 Redis 单命令原子性已足够；
 * 真正需要互斥的（如提现状态流转）走数据库原子 UPDATE...WHERE，不在这里解决。
 */

/**
 * Lua：自增并在**首次**写入时设置 TTL。
 * 拆成两步 INCR+EXPIRE 会在进程崩溃时留下永不过期的 key，Lua 保证原子。
 */
const INCR_WITH_TTL_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Lua：把一个「轮次标识」加入集合，返回**不同轮次的累计数**。
 * 只有集合从空变为非空（第一个轮次）时才设 TTL → 固定窗口，与 incr 语义一致。
 */
const ADD_ROUND_LUA = `
redis.call('SADD', KEYS[1], ARGV[1])
local n = redis.call('SCARD', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return n
`;

interface MemEntry {
  /** 字符串值（set/get 用） */
  value: string | null;
  /** 计数值（incr/getCount 用） */
  count: number;
  /** 已记录的轮次（addRound/roundCount 用） */
  rounds?: Set<string>;
  expiresAt: number;
}

/** 所有 store 实例，供统一的内存兜底过期清理 */
const allStores: DistributedStore[] = [];

export class DistributedStore {
  /** 内存兜底：完整 key -> entry */
  private readonly mem = new Map<string, MemEntry>();

  /** @param ns Redis key 命名空间，隔离不同用途（如 'auth:send' / 'pay:wd'） */
  constructor(private readonly ns: string) {
    allStores.push(this);
  }

  private key(k: string): string {
    return `${this.ns}:${k}`;
  }

  // ── 计数 ────────────────────────────────────────────

  /**
   * 计数 +1 并返回**自增后**的值。首次写入时设定 TTL（固定窗口，后续自增不续期）。
   * Redis 不可用 → 退回本进程内存计数（此时多副本各自计数，不会比改造前更差）。
   */
  async incr(k: string, ttlSec: number): Promise<number> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const n = (await r.eval(INCR_WITH_TTL_LUA, 1, rk, String(ttlSec))) as number;
        return Number(n) || 1;
      } catch {
        reportRedisFailure(r);
      }
    }
    const now = Date.now();
    const e = this.mem.get(rk);
    if (!e || e.expiresAt <= now) {
      this.mem.set(rk, { value: null, count: 1, expiresAt: now + ttlSec * 1000 });
      return 1;
    }
    e.count += 1;
    return e.count;
  }

  /** 读计数值；不存在或已过期返回 0 */
  async getCount(k: string): Promise<number> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const raw = await r.get(rk);
        if (raw == null) return 0;
        return Number(raw) || 0;
      } catch {
        reportRedisFailure(r);
      }
    }
    const e = this.mem.get(rk);
    if (!e || e.expiresAt <= Date.now()) return 0;
    return e.count;
  }

  /** 清零计数（等价于删除 key） */
  async reset(k: string): Promise<void> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        await r.del(rk);
      } catch {
        reportRedisFailure(r);
      }
      // Redis 侧已删，同时清掉本进程可能残留的兜底条目，避免降级回来时读到旧值
      this.mem.delete(rk);
      return;
    }
    this.mem.delete(rk);
  }

  // ── 轮次去重计数 ──────────────────────────────────────

  /**
   * 记录一次「第 N 轮命中」，返回**不同轮次的累计数**（同一轮重复调用不增加）。
   *
   * 存在的理由：普通 `incr` 在多副本下会被稀释成反效果。设想一个
   * 「连续 2 轮都确认 404 才放行」的资金安全闸 —— 单副本时 incr 每轮 +1，需要 2 轮；
   * 多副本时 N 个副本在同一轮内各 incr 一次，计数**一轮就顶到 N**，
   * 于是「连续 2 轮确认」被降级成「同一轮的并发确认」，瞬时误判概率大增。
   *
   * 轮次计数把同一轮的并发调用折叠成 1：无论几个副本同时报，round 相同就只记一次。
   * 只有**跨了不同的轮次**计数才会增长，语义与单副本下的 incr 完全一致。
   *
   * @param round 轮次标识，由调用方按任务周期生成（如 `Math.floor(Date.now()/周期)`）
   * @returns 不同轮次的累计数（≥1）
   */
  async addRound(k: string, round: string, ttlSec: number): Promise<number> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const n = (await r.eval(ADD_ROUND_LUA, 1, rk, round, String(ttlSec))) as number;
        return Number(n) || 1;
      } catch {
        reportRedisFailure(r);
      }
    }
    const now = Date.now();
    let e = this.mem.get(rk);
    if (!e || e.expiresAt <= now) {
      e = { value: null, count: 0, rounds: new Set(), expiresAt: now + ttlSec * 1000 };
      this.mem.set(rk, e);
    }
    if (!e.rounds) e.rounds = new Set();
    e.rounds.add(round);
    return e.rounds.size;
  }

  /** 读已命中的不同轮次数；不存在或已过期返回 0 */
  async roundCount(k: string): Promise<number> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const n = await r.scard(rk);
        return Number(n) || 0;
      } catch {
        reportRedisFailure(r);
      }
    }
    const e = this.mem.get(rk);
    if (!e || e.expiresAt <= Date.now()) return 0;
    return e.rounds ? e.rounds.size : 0;
  }

  // ── 字符串值 ────────────────────────────────────────

  /** 写入字符串值（覆盖写），带 TTL */
  async set(k: string, v: string, ttlSec: number): Promise<void> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        await r.set(rk, v, 'EX', ttlSec);
        return;
      } catch {
        reportRedisFailure(r);
      }
    }
    this.mem.set(rk, { value: v, count: 0, expiresAt: Date.now() + ttlSec * 1000 });
  }

  /** 读字符串值；不存在或已过期返回 null */
  async get(k: string): Promise<string | null> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const raw = await r.get(rk);
        return raw == null ? null : raw;
      } catch {
        reportRedisFailure(r);
      }
    }
    const e = this.mem.get(rk);
    if (!e || e.expiresAt <= Date.now()) return null;
    return e.value;
  }

  // ── 一次性标记（去重）────────────────────────────────

  /**
   * 标记：仅当 key 不存在时写入，返回 true 表示**本次是首次标记**（调用方应执行动作）。
   * 用于告警去重、后台任务链去重等「同一件事只做一次」的场景。
   */
  async markOnce(k: string, ttlSec: number): Promise<boolean> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const res = await r.set(rk, '1', 'EX', ttlSec, 'NX');
        return res === 'OK';
      } catch {
        reportRedisFailure(r);
      }
    }
    const now = Date.now();
    const e = this.mem.get(rk);
    if (e && e.expiresAt > now) return false; // 已标记且未过期
    this.mem.set(rk, { value: '1', count: 0, expiresAt: now + ttlSec * 1000 });
    return true;
  }

  /** 标记是否仍存在（未过期）。用于「已有别的副本在跑，本处跳过」这类判断 */
  async exists(k: string): Promise<boolean> {
    const rk = this.key(k);
    const r = getSharedRedis();
    if (r) {
      try {
        const n = await r.exists(rk);
        return n > 0;
      } catch {
        reportRedisFailure(r);
      }
    }
    const e = this.mem.get(rk);
    return !!e && e.expiresAt > Date.now();
  }

  /** 取消标记（任务链结束/状态复位时调用，允许后续重新标记） */
  async unmark(k: string): Promise<void> {
    await this.reset(k);
  }

  /** 清理内存兜底中的过期条目 */
  sweep(now: number): void {
    for (const [k, v] of this.mem) {
      if (v.expiresAt <= now) this.mem.delete(k);
    }
  }
}

// 内存兜底的过期清理（Redis 正常时这里基本是空的，开销可忽略）
const sweeper = setInterval(
  () => {
    const now = Date.now();
    for (const s of allStores) s.sweep(now);
  },
  600_000,
);
// 不阻止进程退出
if (typeof sweeper.unref === 'function') sweeper.unref();
