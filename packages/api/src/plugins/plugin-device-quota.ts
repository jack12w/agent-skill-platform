import { EntityManager } from 'typeorm';
import { isSubscriptionEntitled, subscriptionSeats } from './plugin-auth.util';

/**
 * 设备档位配额（0046「一档一台」）。
 *
 * ## 为什么需要这个模块
 *
 * 0042 之后，同一用户在同一插件族里可以同时持有多行订阅：
 * 基础版 / Pro 标准版 / 新用户试用 / Team 专业版 各一行。但设备表此前只有
 * `(user_id, plugin_id, device_id)`，答不出「这台机器占的是哪一档的名额」，
 * 于是设备上限只能取一个标量：
 *
 *     个人 → 主插件 max_activations（恒为 1）
 *     团队 → 订阅行 max_devices_per_member（恒为 1）
 *
 * 结果就是「买了两档也只有 1 台」。现在设备行记录 `subscription_id`，
 * 配额按**行**计算、按**行**占用，天然满足「一个订阅类型只能授权一个设备」。
 *
 * ## 配额口径（唯一，别在别处另写一份）
 *
 * | 行类型 | 本行设备额度 | 依据 |
 * |---|---|---|
 * | 个人行（team_id 为空） | **1 台** | 一卡一台 |
 * | 团队行 | `max_devices_per_member`（默认 1，是「每人几台」）| **不是 seats** |
 *
 * ⚠️ 团队行的 `seats`（= 可授权账号数，如 3）是「能坐 3 个人」，**不是 3 台设备**。
 *    拿 seats 当设备额度会让团长一个人绑 3 台机器 —— 这是本模块存在的核心原因之一。
 *
 * ⚠️ **一张订阅卡 = 一台设备配额**（2026-10-29 产品口径定稿）。团队版也享受
 *    「一卡一台」，它多出来的是**成员席位**（每个成员各在自己的卡上占 1 台），
 *    与「这台卡能绑几台设备」是两个维度。因此：
 *      · 卡上显示的数字必须是 `options[i].quota / options[i].used`（本行）
 *      · 绝不能把 `summarizeQuota().max_devices`（各在期行之和）贴到单张卡上
 *        —— 那会让「基础版」显示 2 台（自己 1 台 + 团队行 1 台），用户直接看错。
 *
 * ⚠️ 配额与**权益判定同源**：设备绑哪一档，就只享那一档的能力与额度。
 *    档位看「可授权账号数 > 1」（plugin-auth.util isTeamTier），输入的行 = 设备行上的
 *    `subscription_id`（`resolvePluginSubscription(..., { pinSubscriptionId })`）。
 *    于是「绑基础版的那台机器没有 AI」是设计意图，不是 bug ——
 *    权益按档、按设备走，否则「绑哪一档」对能力毫无影响，一档一台只剩配额意义。
 *
 * `used` 只统计**本人**占用该行的设备：团队行是全体成员共享的，额度却是每人一份，
 * 所以不能把别人的设备算进自己的已用量。
 */

export interface DeviceTierOption {
  /** 订阅行 id —— 授权时提交它，后端据此占名额 */
  subscription_id: string;
  /** 所购商品（基础版 / Pro / 试用 / Team 专业版）*/
  plan_id: string | null;
  plan_slug: string | null;
  plan_name: string | null;
  /** personal = 个人档（无 AI）；team = 团队档（有 AI） */
  via: 'personal' | 'team';
  /** 是否在期内（active/cancelled 且未到期）—— 过期档位置灰但保留展示 */
  entitled: boolean;
  expires_at: string | null;
  /** 团队行才有：可授权账号数（含团长） */
  seats: number | null;
  /** 本行设备额度 */
  quota: number;
  /** 本人已占用本行的设备数 */
  used: number;
  remaining: number;
  full: boolean;
  /** 前端默认选中项：第一个「在期内且未满」的档位 */
  recommended: boolean;
}

/** 单行的设备额度（口径见文件头，改这里等于改全站） */
export function deviceQuotaOfRow(row: {
  team_id?: string | null;
  max_devices_per_member?: number | string | null;
}): number {
  if (!row?.team_id) return 1;
  const n = Number(row.max_devices_per_member ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

interface RawTierRow {
  id: string;
  plugin_id: string | null;
  team_id: string | null;
  tier: string | null;
  seats: number | string | null;
  max_devices_per_member: number | string | null;
  status: string | null;
  expires_at: string | Date | null;
  entitled: boolean;
  row_used: number | string | null;
  plan_id: string | null;
  plan_slug: string | null;
  plan_name: string | null;
}

/**
 * 列出该用户在该插件族内「可用来授权设备」的全部订阅档位。
 *
 * 返回包含**已过期**的行（前端置灰展示，让用户看见「我买过 Pro，但过期了」），
 * 顺序：在期内优先 → 未满优先 → 到期最晚优先。调用方据此选默认项。
 */
export async function listDeviceTierOptions(
  em: EntityManager,
  userId: string,
  rootPluginId: string,
): Promise<DeviceTierOption[]> {
  const rows: RawTierRow[] = await em.query(
    `SELECT s.id,
            s.plugin_id,
            s.team_id,
            s.tier,
            s.seats,
            s.max_devices_per_member,
            s.status,
            s.expires_at,
            (s.status IN ('active', 'cancelled') AND s.expires_at > now()) AS entitled,
            (SELECT COUNT(*)::int FROM plugin_devices d
              WHERE d.user_id = $1
                AND d.subscription_id = s.id
                AND d.revoked_at IS NULL) AS row_used,
            p.id   AS plan_id,
            p.slug AS plan_slug,
            p.name AS plan_name
       FROM plugin_subscriptions s
       LEFT JOIN plugins p ON p.id = s.plugin_id
      WHERE s.root_plugin_id = $2::uuid
        AND (
              (s.team_id IS NULL AND s.user_id = $1)
              OR (s.team_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM team_members m
                     WHERE m.team_id = s.team_id AND m.user_id = $1))
            )
      ORDER BY (s.status IN ('active', 'cancelled') AND s.expires_at > now()) DESC,
               s.expires_at DESC`,
    [userId, rootPluginId],
  );

  const options: DeviceTierOption[] = (rows || []).map((r) => {
    const quota = deviceQuotaOfRow(r);
    const used = Number(r.row_used ?? 0) || 0;
    // 团队档判定与 AI 门禁同源：可授权账号数 > 1
    const seats = r.team_id
      ? subscriptionSeats({
          seats: r.seats,
          team_id: r.team_id,
          tier: r.tier,
        })
      : null;
    return {
      subscription_id: r.id,
      plan_id: r.plan_id,
      plan_slug: r.plan_slug,
      plan_name: r.plan_name,
      via: seats !== null && seats > 1 ? 'team' : 'personal',
      // 时间判定走纯函数，避免 SQL 与 JS 两套时钟给出不一致结论
      entitled: isSubscriptionEntitled({
        status: r.status,
        expires_at: r.expires_at,
      }),
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      seats,
      quota,
      used,
      remaining: Math.max(0, quota - used),
      full: used >= quota,
      recommended: false,
    };
  });

  const pick =
    options.find((o) => o.entitled && !o.full) ??
    options.find((o) => o.entitled) ??
    options[0];
  if (pick) pick.recommended = true;

  return options;
}

/**
 * 汇总：**插件族总**额度 / 已占用量。
 *
 * ⚠️ 只用于「这个用户在本插件最多能绑几台」这类全局场景（授权页顶部一行）。
 *    **禁止**把它贴到单张订阅卡上：那是各在期行之和，会让「基础版」显示成 2 台。
 *    单卡请直接用 `options[i].quota / used`（账号页 tiers 明细同源）。
 *
 * `max` 只累加**在期内**档位的额度 —— 过期档位不该继续扩额。
 * 已占用量由调用方传入真实设备数（不能把各行的 used 相加：subscription_id 为空的历史
 * 设备不属于任何一行，相大会漏算，导致「界面说还能绑、实际被拒」）。
 */
export function summarizeQuota(
  options: DeviceTierOption[],
  actualUsed: number,
): { max_devices: number; devices_used: number } {
  const max = options
    .filter((o) => o.entitled)
    .reduce((acc, o) => acc + o.quota, 0);
  return {
    // 一个在期内档位都没有时给 0：授权按钮那边本来就会因「未订阅」被拦住
    max_devices: max,
    devices_used: Math.max(0, actualUsed || 0),
  };
}
