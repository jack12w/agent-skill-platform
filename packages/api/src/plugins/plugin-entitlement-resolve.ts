import { EntityManager } from 'typeorm';
import { PluginSubscription } from './plugin.entity';

/**
 * 插件订阅解析（席位制 0035 + 商品族 0041）——所有「查某用户的插件订阅」的查询层收口。
 *
 * 解析规则：
 *  · 个人订阅：team_id IS NULL 且 user_id = 本人（行为与 0035 之前一致）
 *  · 团队席位：team_id 非 NULL 的有效团队订阅行，且本人在该团队在册（team_members 实时查）
 *    → 移除成员即失权，无需吊销设备；设备行仍按成员各自的 (user_id, plugin_id) 隔离。
 *  · 多行命中时优先级（2026-10-29 口径定稿）：
 *      ① 有权(entitled) 行最优先（否则过期团队行会遮住有效个人行）
 *      ② 同为有权时**团队档优先**（`COALESCE(seats,1) > 1`）—— AI 只对团队档开，
 *         用户同时持有个人版 + 团队版时必须拿团队版
 *      ③ 再按 expires_at 降序（剩余时长最长者优先）
 *
 * ⚠️ `isSubscriptionEntitled`（plugin-auth.util）仍是权益判定的唯一口径；本函数只负责
 *    「找到该看哪一行」。entitled 标记用同一规则（status IN active/cancelled + 未到期）
 *    在 SQL 里预计算，两者口径必须同步改。
 *
 * ★ 0042（一档一行）——**查询范围改为 `root_plugin_id`**：
 *   订阅行的 plugin_id 现在是「用户买的那个商品」（基础版 / Pro / 试用 / 独立商品），
 *   权益归属另存 root_plugin_id。扩展端传进来的 device.plugin_id 恒为主插件行 id，
 *   正好等于 root_plugin_id，因此这里一次索引命中即可，不再需要 0041 那套商品族
 *   UNION 子查询，也不依赖 slug 前缀兜底。
 *   同一插件下用户可以有**多行**（买过基础版 + Pro + 试用各一行），由下面的排序择优。
 *
 * 原始 SQL 而非 QueryBuilder：team_members 是 teams 模块的实体，调用方（ai 模块等）
 * 未必在 forFeature 注册过它，raw query 不依赖实体注册。
 */
export interface ResolvedPluginSubscription {
  /** 命中的订阅行（原始行字段；团队行带 team_id / seats / max_devices_per_member） */
  sub: PluginSubscription;
  /** via='team' = 权益来自团队席位（本人不是团长也可能是成员） */
  via: 'personal' | 'team';
  /** 是否有权（isSubscriptionEntitled 同口径：active/cancelled 且未到期） */
  entitled: boolean;
}

export async function resolvePluginSubscription(
  em: EntityManager,
  userId: string,
  pluginId: string,
): Promise<ResolvedPluginSubscription | null> {
  // 0042（一档一行）：权益归属收口到 root_plugin_id，不再用商品族 UNION 子查询。
  // 扩展端传进来的 device.plugin_id 恒为主插件行 id，正好等于 root_plugin_id，
  // 因此查询变成一次索引命中（idx_plugin_subs_root），不再依赖 slug 前缀兜底。
  const rows: any[] = await em.query(
    `SELECT s.*,
            (s.team_id IS NOT NULL) AS _via_team,
            (s.status IN ('active', 'cancelled') AND s.expires_at > now()) AS _entitled
       FROM plugin_subscriptions s
      WHERE s.root_plugin_id = $2::uuid
        AND (
          (s.team_id IS NULL AND s.user_id = $1)
          OR (s.team_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM team_members m
                 WHERE m.team_id = s.team_id AND m.user_id = $1))
        )
      ORDER BY _entitled DESC,
               (COALESCE(s.seats, 1) > 1) DESC,
               s.expires_at DESC
      LIMIT 1`,
    [userId, pluginId],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    sub: r as PluginSubscription,
    // ⚠️ via 的语义严格保持「权益来自团队席位（team_id 非空）」——权限边界用它区分
    // 「自己买的」与「团里给的」。**AI / 档位判定不要用它**：那要看 `seats`
    // （plugin-auth.util isTeamTier），因为团队行也可能只有 1 席（此时不算团队档）。
    via: r._via_team ? 'team' : 'personal',
    entitled: !!r._entitled,
  };
}
