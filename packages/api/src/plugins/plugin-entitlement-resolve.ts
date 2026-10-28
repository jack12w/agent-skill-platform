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
 * ★ 2026-10-29 设备级鉴权（`pinSubscriptionId`）——**有设备身份时不许择优**：
 *
 *   上面那套「team 优先 + 到期最晚」是**账号级**口径，回答的是「这个账号最好的权益是
 *   哪一档」。但「一档一台」之后，每台设备在授权时都明确选了某一档（`plugin_devices.
 *   subscription_id`，0046），它只该拿到**那一档**的能力 —— 否则「绑哪一档」对权益
 *   毫无影响，一档一台就只剩配额意义，商业规则是空的。
 *
 *   实测症状（用户反馈）：微软浏览器绑的是基础版，`poll` / `entitlement` 却按账号级
 *   择优拿到 Team 行 → 返回 `tier=team` → 扩展端挂出 AI。基础版那台机器遂"白拿"团队能力。
 *
 *   因此三个持有设备令牌的入口（`plugins/auth/poll`、`plugins/entitlement`、
 *   `ai/data/push`）都传 `pinSubscriptionId = device.subscription_id`：
 *     · pin 命中 → 直接用该行（`pin_applied=true`），entitled 可能是 false（该档过期）
 *     · pin 未命中（行被删 / 不属于本人 / 已被移出团）→ **回落择优**保住可用性，
 *       并让调用方可通过 `pin_applied=false` 观测异常
 *
 *   ⚠️ 唯一没有设备身份的入口是 `ai/data/query`（`ai_sk_…` 是账号级密钥，见
 *      ai-query.service.ts ③ 的说明）：它只能继续用账号级口径，这不是漏改。
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
  /**
   * 本次是否真的按「设备所绑那一档」命中。
   *  · true  = 传了 pin 且命中（设备级鉴权生效）
   *  · false = 没传 pin（账号级口径），或 pin 失效回落到择优
   * 调用方用它打日志/做观测，不要用它参与权限判定。
   */
  pin_applied: boolean;
}

/** 设备行里 subscription_id 是 uuid；非法输入直接跳过 pin，避免 `::uuid` 抛错打成 500 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 一条 SELECT 复用给「pin 精确命中」与「账号级择优」两个场景：
 * 权限边界（个人行归本人 / 团队行需本人在册）完全一致，只有 WHERE 与 ORDER 不同。
 */
const SELECT_SUB = `
  SELECT s.id, s.user_id, s.plugin_id, s.root_plugin_id, s.team_id,
         s.plan, s.tier, s.seats, s.max_devices_per_member,
         s.price_cents, s.currency, s.status, s.started_at, s.expires_at, s.order_id,
         (s.team_id IS NOT NULL) AS _via_team,
         (s.status IN ('active', 'cancelled') AND s.expires_at > now()) AS _entitled
    FROM plugin_subscriptions s`;

/** 权限边界：个人行必须本人；团队行必须本人在册（成员被移出即失权，无需吊销设备） */
const ACCESS_SQL = `
   AND (
     (s.team_id IS NULL AND s.user_id = $1)
     OR (s.team_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM team_members m
            WHERE m.team_id = s.team_id AND m.user_id = $1))
   )`;

export async function resolvePluginSubscription(
  em: EntityManager,
  userId: string,
  pluginId: string,
  opts?: { pinSubscriptionId?: string | null },
): Promise<ResolvedPluginSubscription | null> {
  const pin = String(opts?.pinSubscriptionId || '').trim();

  /**
   * ① 设备级：设备绑了哪一档就只看那一档（0046 一档一台）。
   *
   * 不看 entitled —— 该档过期也要如实返回，调用方才能给出「这一档到期了」而不是
   * 悄悄换成账号里另一档继续放行（那就是本条注释要消灭的那个 bug）。
   */
  if (pin && UUID_RE.test(pin)) {
    const pinned: any[] = await em.query(
      `${SELECT_SUB}
        WHERE s.id = $3::uuid
          AND s.root_plugin_id = $2::uuid
          ${ACCESS_SQL}
        LIMIT 1`,
      [userId, pluginId, pin],
    );
    if (pinned && pinned[0]) {
      const r = pinned[0];
      return {
        sub: r as PluginSubscription,
        via: r._via_team ? 'team' : 'personal',
        entitled: !!r._entitled,
        pin_applied: true,
      };
    }
    // 落到这里说明设备行指向了一条不该看见的订阅（被删 / 换人 / 已被移出团）。
    // 回落择优：宁可恢复成账号级行为，也不要让用户忽然整台机器失效 —— 这属于运维
    // 异常，不是用户的选择。调用方拿到 pin_applied=false 可据此告警。
  }

  // ② 账号级（未传 pin / pin 失效时）：team 优先 + 到期最晚
  const rows: any[] = await em.query(
    `${SELECT_SUB}
      WHERE s.root_plugin_id = $2::uuid
        ${ACCESS_SQL}
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
    pin_applied: false,
  };
}
