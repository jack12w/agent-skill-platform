-- 0042: 订阅模型改为「一档一行」（2026-10-28 用户拍板 · 重建历史）
--
-- ── 为什么改 ──────────────────────────────────────────────────────────────
-- 旧模型把「权益归属」和「买了哪一档」挤在同一行的 plugin_id 上，另靠
-- source_plugin_id（0040）记「最近一次购买」。后果：
--   · 买 Pro 不新增行，只顺延原个人行 → 用户买过的档位在数据里全部消失，
--     账号中心只能显示「最后买的那一档」，到期/失效后连记录都看不到；
--   · 后台按商品筛订阅要靠 source_plugin_id 猜归属，猜不到的用户直接消失；
--   · 续费按 source 反推下单，年付用户被按 ¥49/月 续费（少给 335 天，真资损）。
--
-- ── 新模型 ────────────────────────────────────────────────────────────────
-- 一行 = 一次「某用户买了某个具体商品」的权益：
--   plugin_id       = 用户所购商品行 id（基础版 / Pro / 试用 / 独立商品）
--   root_plugin_id  = 权益归属的插件（所购商品的 parent，独立商品即自身）
--   team_id         = 非空即团队行（专业版），权益覆盖在册成员
-- 删掉 source_plugin_id —— 它要表达的信息已经由 plugin_id 直接承载。
--
-- 权益解析（扩展端 / AI 门禁）：按 (user_id, root_plugin_id) 取全部行，
--   排序 = 有权优先 > 团队优先 > 到期最晚，取第一条。
--
-- ⚠️ 生产不自动跑迁移：先整份 psql 执行；文件自带 BEGIN? 不需要 ——
--    用 `psql --single-transaction` 调用即可保证全成全败。

-- ─────────────────────────── 1. 结构 ───────────────────────────
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS root_plugin_id uuid;

-- 回填 root：此刻 plugin_id 仍是「权益行」（多为主插件行），其 parent 就是 root
UPDATE plugin_subscriptions s
   SET root_plugin_id = COALESCE(p.parent_plugin_id, p.id)
  FROM plugins p
 WHERE p.id = s.plugin_id
   AND s.root_plugin_id IS NULL;

-- 兜底：plugin_id 指向的商品行已不存在（历史脏数据）→ 视为独立商品
UPDATE plugin_subscriptions
   SET root_plugin_id = plugin_id
 WHERE root_plugin_id IS NULL;

-- 先拆掉旧的部分唯一索引：接下来要临时允许同 (user, plugin) 出现两行（合并期间）
DROP INDEX IF EXISTS uq_plugin_subs_user_plugin_personal;

-- ─────────────────── 2. 权益行还原为「所购商品」 ───────────────────
-- 0040 起 source_plugin_id 记录最近一次购买的商品；把 plugin_id 改成它。
-- 若目标商品上已有行（0041 归档行），合并：取更晚到期 + 更早开始 + 保留订单，
-- 然后删掉被并掉的那条（信息已完整并入，不保留重复行 —— 唯一索引不允许）。
DO $$
DECLARE
  rec RECORD;
  tgt RECORD;
  moved int := 0;
  merged int := 0;
BEGIN
  FOR rec IN
    SELECT s.id, s.user_id, s.team_id, s.plugin_id AS cur_pid,
           s.source_plugin_id AS src_pid, s.status, s.expires_at, s.started_at,
           s.order_id, s.price_cents
      FROM plugin_subscriptions s
      JOIN plugins sp ON sp.id = s.source_plugin_id   -- 所购商品必须仍存在
     WHERE s.source_plugin_id IS NOT NULL
       AND s.source_plugin_id <> s.plugin_id
     ORDER BY s.expires_at DESC
  LOOP
    SELECT id, status, expires_at INTO tgt
      FROM plugin_subscriptions
     WHERE user_id = rec.user_id
       AND plugin_id = rec.src_pid
       AND ((rec.team_id IS NULL AND team_id IS NULL) OR team_id = rec.team_id)
       AND id <> rec.id
     LIMIT 1;

    IF tgt.id IS NULL THEN
      UPDATE plugin_subscriptions
         SET plugin_id = rec.src_pid,
             root_plugin_id = COALESCE(
               (SELECT COALESCE(p.parent_plugin_id, p.id) FROM plugins p WHERE p.id = rec.src_pid),
               root_plugin_id)
       WHERE id = rec.id;
      moved := moved + 1;
    ELSE
      UPDATE plugin_subscriptions t
         SET expires_at  = GREATEST(t.expires_at, rec.expires_at),
             started_at  = LEAST(t.started_at, rec.started_at),
             order_id    = COALESCE(rec.order_id, t.order_id),
             price_cents = CASE WHEN rec.expires_at > t.expires_at THEN rec.price_cents
                                ELSE t.price_cents END,
             status      = CASE
                             WHEN rec.status IN ('active','cancelled') AND rec.expires_at > now()
                               THEN rec.status
                             WHEN t.status IN ('active','cancelled') AND t.expires_at > now()
                               THEN t.status
                             ELSE t.status
                           END
       WHERE t.id = tgt.id;
      DELETE FROM plugin_subscriptions WHERE id = rec.id;
      merged := merged + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0042: 归位完成，直接改 plugin_id % 行，合并 % 行', moved, merged;
END $$;

-- ─────────────── 3. 按订单重建被覆盖掉的历史档位行 ───────────────
-- 旧模型下「买过但被后续购买覆盖」的档位，数据里已无痕迹，只能从订单还原。
-- 只补「没有任何订阅行引用该订单」的订单 —— 已被代表的不重复插入。
-- 补出来的行一律 status='expired'：它们只用于展示「买过什么」，
-- **不参与权益判定**（判权只认 active/cancelled），因此到期时间即使推算不精确
-- 也不会让谁多拿权益。
INSERT INTO plugin_subscriptions (
  user_id, plugin_id, root_plugin_id, plan, tier, price_cents,
  status, started_at, expires_at, order_id
)
SELECT o.user_id,
       i.subject_id,
       COALESCE(p.parent_plugin_id, p.id),
       'monthly',
       'personal',
       o.paid_cents,
       'expired',
       COALESCE(o.paid_at, o.created_at),
       COALESCE(o.paid_at, o.created_at)
         + ((COALESCE(p.subscription_duration_days, 30)) || ' days')::interval,
       o.id
  FROM orders o
  JOIN order_items i ON i.order_id = o.id
  JOIN plugins p     ON p.id = i.subject_id
 WHERE o.type = 'plugin'
   AND o.status IN ('PAID', 'DELIVERED')
   AND COALESCE(o.refunded_cents, 0) = 0
   AND i.subject_type = 'plugin'
   AND i.subject_id IS NOT NULL
   -- 该订单已被某条订阅行代表（团队行 / 试用行 / 当前权益行）→ 不再补
   AND NOT EXISTS (SELECT 1 FROM plugin_subscriptions s2 WHERE s2.order_id = o.id)
   -- 该用户在该商品上已经有个人行 → 不再补
   AND NOT EXISTS (
         SELECT 1 FROM plugin_subscriptions s3
          WHERE s3.user_id = o.user_id AND s3.plugin_id = i.subject_id
            AND s3.team_id IS NULL);

-- ─────────────── 4. 去重（唯一索引前最后一道） ───────────────
-- 同 (user, plugin, team) 仍多于一行时，保留「有权 > 到期更晚」的那条。
DO $$
DECLARE
  grp RECORD;
  keep_id uuid;
  dropped int := 0;
BEGIN
  FOR grp IN
    SELECT user_id, plugin_id, COALESCE(team_id::text, '-') AS tk, COUNT(*) AS c
      FROM plugin_subscriptions
     GROUP BY user_id, plugin_id, COALESCE(team_id::text, '-')
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO keep_id
      FROM plugin_subscriptions
     WHERE user_id = grp.user_id
       AND plugin_id = grp.plugin_id
       AND COALESCE(team_id::text, '-') = grp.tk
     ORDER BY (status IN ('active','cancelled') AND expires_at > now()) DESC,
              expires_at DESC
     LIMIT 1;
    DELETE FROM plugin_subscriptions
     WHERE user_id = grp.user_id
       AND plugin_id = grp.plugin_id
       AND COALESCE(team_id::text, '-') = grp.tk
       AND id <> keep_id;
    dropped := dropped + 1;
  END LOOP;
  RAISE NOTICE '0042: 去重完成，清理 % 组多余行', dropped;
END $$;

-- ─────────────────────────── 5. 约束与索引 ───────────────────────────
ALTER TABLE plugin_subscriptions
  ALTER COLUMN root_plugin_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_subs_root ON plugin_subscriptions (root_plugin_id);

-- 个人行：每人每商品一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_subs_user_product_personal
  ON plugin_subscriptions (user_id, plugin_id)
  WHERE team_id IS NULL;

-- 团队行：每人每商品每团一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_subs_user_product_team
  ON plugin_subscriptions (user_id, plugin_id, team_id)
  WHERE team_id IS NOT NULL;

-- source_plugin_id 已由 plugin_id 取代
ALTER TABLE plugin_subscriptions DROP COLUMN IF EXISTS source_plugin_id;

-- ─────────────────────────── 6. 核对（人工执行） ───────────────────────────
-- ① 每个用户的每档订阅行
-- SELECT u.email, p.slug AS 商品, s.status, s.expires_at, s.team_id IS NOT NULL AS 团队行
--   FROM plugin_subscriptions s
--   JOIN plugins p ON p.id = s.plugin_id
--   JOIN users u ON u.id = s.user_id
--  ORDER BY u.email, p.slug;
--
-- ② 权益归属必须是主插件且非空
-- SELECT COUNT(*) FROM plugin_subscriptions WHERE root_plugin_id IS NULL;
--
-- ③ 同一用户同一商品的个人行不应重复
-- SELECT user_id, plugin_id, COUNT(*) FROM plugin_subscriptions
--  WHERE team_id IS NULL GROUP BY 1,2 HAVING COUNT(*) > 1;
