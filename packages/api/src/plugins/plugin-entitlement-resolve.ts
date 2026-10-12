import { EntityManager } from 'typeorm';
import { PluginSubscription } from './plugin.entity';

/**
 * 插件订阅解析（席位制 0035）——所有「查某用户的插件订阅」的查询层收口。
 *
 * 解析规则（2026-10-12 拍板）：
 *  · 个人订阅：team_id IS NULL 且 user_id = 本人（行为与 0035 之前一致）
 *  · 团队席位：team_id 非 NULL 的有效团队订阅行，且本人在该团队在册（team_members 实时查）
 *    → 移除成员即失权，无需吊销设备；设备行仍按成员各自的 (user_id, plugin_id) 隔离。
 *  · 多行命中时优先级：**有权(entitled) 行最优先**（否则过期团队行会遮住有效个人行）；
 *    同为有权时 team 行优先（AI 功能按 tier='team' 开）；再按 expires_at 降序。
 *
 * ⚠️ `isSubscriptionEntitled`（plugin-auth.util）仍是权益判定的唯一口径；本函数只负责
 *    「找到该看哪一行」。entitled 标记用同一规则（status IN active/cancelled + 未到期）
 *    在 SQL 里预计算，两者口径必须同步改。
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
  const rows: any[] = await em.query(
    `SELECT s.*,
            (s.team_id IS NOT NULL) AS _via_team,
            (s.status IN ('active', 'cancelled') AND s.expires_at > now()) AS _entitled
       FROM plugin_subscriptions s
      WHERE s.plugin_id = $2
        AND (
          (s.team_id IS NULL AND s.user_id = $1)
          OR (s.team_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM team_members m
                 WHERE m.team_id = s.team_id AND m.user_id = $1))
        )
      ORDER BY _entitled DESC,
               _via_team DESC,
               s.expires_at DESC
      LIMIT 1`,
    [userId, pluginId],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    sub: r as PluginSubscription,
    via: r._via_team ? 'team' : 'personal',
    entitled: !!r._entitled,
  };
}
