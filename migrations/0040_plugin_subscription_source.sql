-- 0040：订阅行记录「购买档位商品」（plugin_subscriptions.source_plugin_id）。
-- 幂等，可重复执行。依赖 0039（把落错行的档位订阅搬回主行）已生效。
--
-- 背景（2026-10-12 四轮质检遗留）：
--   权益实体**永远**落在主插件行 alibaba-toolkit（扩展端 auth_core.js 与 AI 门禁
--   都写死只读主行 slug），档位商品（`-b2b` 企业版 / `-year` Pro 年付 / 运营在
--   后台「插件管理」后续新建的任意 `alibaba-toolkit-*` 档位）只是收银台价格档位。
--   旧模型里 plugin_subscriptions 只记 plugin_id（恒为主行 id），**不记录用户当初
--   买的是哪个档位商品**，由此产生三个问题：
--     1) 后台按档位筛选不可信：主行个人订阅与「年付 Pro」在数据上完全不可区分，
--        筛选只能按 tier 粗分桶（团队桶/个人桶），年付行被算进主行个人桶；
--     2) 账号中心续费只能按 tier 猜档位（团队→b2b，其余→主行）：年付用户在
--        `-year` 档买的权益，续费会被按主行 ¥49/月 下单 → 少给 335 天（用户资损）；
--     3) 财务/客服溯源：答不出「这笔订阅是哪一档商品卖出的」。
--
-- 语义：
--   NULL     = 未知（0040 之前且无法由订单还原）或「直接在主插件行购买」
--   非 NULL   = 本行权益**最近一次**发放所依据的商品行 id
--   注：支付发货（orders.fulfillPluginSubscription）与后台手动开通/续期
--       （plugins.adminAddSubscription 新建）都会写入，故它记录的是
--       「最近一次购买档位」而非「首次购买档位」——这正是续费定价需要的语义。
--   后台「编辑订阅」弹窗**不改写**本列（它记录购买事实，不是可编辑的经营字段）。
--
-- ⚠️ 生产库不自动跑迁移：先手工 psql 执行本文件，再上代码。

ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS source_plugin_id uuid;

CREATE INDEX IF NOT EXISTS plugin_subscriptions_source_plugin_id_idx
  ON plugin_subscriptions (source_plugin_id);

-- ── 回填 A：有 order_id 的行，用订单项 subject_id 精确还原（下单时记录的商品 id）──
--    subject_type='plugin' 的订单项 subject_id 就是用户点击「订阅」的那个商品行 id，
--    是当时购买行为的**原始凭证**，比任何猜测都准。
UPDATE plugin_subscriptions s
   SET source_plugin_id = oi.subject_id
  FROM order_items oi
 WHERE s.source_plugin_id IS NULL
   AND s.order_id IS NOT NULL
   AND oi.order_id = s.order_id
   AND oi.subject_type = 'plugin'
   AND oi.subject_id IS NOT NULL;

-- ── 回填 B：仍是空的团队行（team_id 非空 / tier='team'）──
--    当前唯一能产生团队权益的档位商品是 `-b2b`（见 orders.tierOfTierSlug），
--    故团队行的购买档位可由 tier 唯一确定。个人行**不猜**（无法区分主行直购与
--    历史 `-year` 购买），保持 NULL，由列表筛选按「主行直购」兜底归类。
UPDATE plugin_subscriptions s
   SET source_plugin_id = p.id
  FROM plugins p
 WHERE s.source_plugin_id IS NULL
   AND (s.team_id IS NOT NULL OR COALESCE(s.tier, 'personal') = 'team')
   AND p.slug = 'alibaba-toolkit-b2b';

DO $$
DECLARE
  n_set  int;
  n_null int;
BEGIN
  SELECT count(*) INTO n_set  FROM plugin_subscriptions WHERE source_plugin_id IS NOT NULL;
  SELECT count(*) INTO n_null FROM plugin_subscriptions WHERE source_plugin_id IS NULL;
  RAISE NOTICE '0040: source_plugin_id 已回填 % 行；仍为 NULL（历史未知/主行直购）% 行', n_set, n_null;
END $$;
