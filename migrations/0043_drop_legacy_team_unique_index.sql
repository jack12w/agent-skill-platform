-- 0043: 删除 0037 遗留的团队行唯一索引（与 0042「每人每商品每团一行」冲突）
--
-- ── 问题 ─────────────────────────────────────────────────────────────────
-- 0037 建的是：
--     ON plugin_subscriptions (user_id, plugin_id) WHERE team_id IS NOT NULL
-- **列里不含 team_id**，语义 = 「同一用户同一商品，全局只能有一条团队行」。
--
-- 0042 的新模型要求团队行按团独立：
--     uq_plugin_subs_user_product_team = (user_id, plugin_id, team_id) WHERE team_id IS NOT NULL
--
-- 旧索引比新索引更严，会拒绝合法写入：同一人在 A 团、B 团各持一份同一商品
-- （例如两个团长各自为他开通 Team 专业版）时：
--   · 后台手工开通 → unique_violation → 接口 500
--   · 支付发货 upsert → 静默失败 → 用户付费后无权益
--
-- 0042 第 41 行只 DROP 了 personal 版旧索引，漏了这个 team 版，此处补齐。
--
-- ── 安全性 ───────────────────────────────────────────────────────────────
-- 删除唯一约束只会「放宽」，不可能因存量数据而失败，也不需要去重。
-- 权限判定不依赖该索引（resolvePluginSubscription 走 root_plugin_id + 排序 LIMIT 1）。
-- 删除后团队行的唯一性由 uq_plugin_subs_user_product_team 接管。
--
-- 生产执行：
--   psql --single-transaction -v ON_ERROR_STOP=1 -f 0043_drop_legacy_team_unique_index.sql

DO $$
DECLARE
  had boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'plugin_subscriptions'
       AND indexname = 'uq_plugin_subs_user_plugin_team'
  ) INTO had;

  IF NOT had THEN
    RAISE NOTICE '0043: 旧索引不存在，跳过（幂等）';
  ELSE
    EXECUTE 'DROP INDEX uq_plugin_subs_user_plugin_team';
    RAISE NOTICE '0043: 已删除旧团队唯一索引 uq_plugin_subs_user_plugin_team';
  END IF;

  -- 复核：三条关键索引必须齐全，旧的那条必须消失
  RAISE NOTICE '0043: 现存 team 行索引 → %',
    (SELECT string_agg(indexname, ', ' ORDER BY indexname)
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'plugin_subscriptions'
        AND indexname LIKE 'uq_plugin_subs%');
END $$;
