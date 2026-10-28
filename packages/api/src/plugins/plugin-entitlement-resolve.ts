import { EntityManager } from 'typeorm';
import { PluginSubscription } from './plugin.entity';

/**
 * 插件订阅解析（席位制 0035 + 商品族 0041）——所有「查某用户的插件订阅」的查询层收口。
 *
 * 解析规则：
 *  · 个人订阅：team_id IS NULL 且 user_id = 本人（行为与 0035 之前一致）
 *  · 团队席位：team_id 非 NULL 的有效团队订阅行，且本人在该团队在册（team_members 实时查）
 *    → 移除成员即失权，无需吊销设备；设备行仍按成员各自的 (user_id, plugin_id) 隔离。
 *  · 多行命中时优先级（2026-10-28 排序口径定稿）：
 *      ① 有权(entitled) 行最优先（否则过期团队行会遮住有效个人行）
 *      ② 同为有权时**专业版优先**（team 席位 或 tier='team'）—— AI 功能只对 team 开，
 *         用户同时持有个人版 + 团队版时必须拿团队版
 *      ③ 再按 expires_at 降序（剩余时长最长者优先）
 *
 * ⚠️ `isSubscriptionEntitled`（plugin-auth.util）仍是权益判定的唯一口径；本函数只负责
 *    「找到该看哪一行」。entitled 标记用同一规则（status IN active/cancelled + 未到期）
 *    在 SQL 里预计算，两者口径必须同步改。
 *
 * ★ 0041（2026-10-28 生产事故）——**查询范围从「单个 plugin_id」扩大到「商品族」**：
 *   以前只按 device.plugin_id（主插件行）精确匹配，于是落错行的档位/试用订阅（如
 *   slug 被填成 `7testing` 的试用商品）永远查不到，用户买了权益却一直看到「已过期」。
 *   现在族内 = 自己 + parent_plugin_id 指向自己的商品 + （自己是主插件时）slug 前缀族。
 *   有了显式字段后正常路径不会出现错行，这一层是**防御性兜底**：万一还有残留，
 *   也能按上面的优先级选到最好的那一条，不会整片失权。
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
      WHERE s.plugin_id IN (
              /* 本行自身 */
              SELECT $2::uuid
              UNION
              /* 显式声明归属于本行的档位 / 试用商品（0041） */
              SELECT p.id FROM plugins p WHERE p.parent_plugin_id = $2::uuid
              UNION
              /* 兜底：自己是主插件时，slug 前缀族里尚未回填 parent_plugin_id 的历史商品 */
              SELECT c.id
                FROM plugins c
                JOIN plugins me ON me.id = $2::uuid
               WHERE me.slug = 'alibaba-toolkit'
                 AND c.slug LIKE 'alibaba-toolkit-%'
                 AND c.id <> me.id
            )
        AND (
          (s.team_id IS NULL AND s.user_id = $1)
          OR (s.team_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM team_members m
                 WHERE m.team_id = s.team_id AND m.user_id = $1))
        )
      ORDER BY _entitled DESC,
               (s.team_id IS NOT NULL OR COALESCE(s.tier, 'personal') = 'team') DESC,
               s.expires_at DESC
      LIMIT 1`,
    [userId, pluginId],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    sub: r as PluginSubscription,
    // ⚠️ via 的语义严格保持「权益来自团队席位（team_id 非空）」——调用方用它决定
    // 设备上限（plugins-auth.service 取订阅行的 max_devices_per_member，个人行该列为
    // NULL → 会被压到 1 台）。后台手工置 tier='team' 的个人行**不**算 via=team，
    // 它只参与上面的排序优先级；返回给插件的 tier 另有 `|| sub.tier === 'team'` 兜底。
    via: r._via_team ? 'team' : 'personal',
    entitled: !!r._entitled,
  };
}
