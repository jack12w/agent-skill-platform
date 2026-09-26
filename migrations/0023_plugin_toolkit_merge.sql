-- 插件商品模型合并：3 条独立商品 → 1 个商品 + 3 个功能
--
-- 背景：`shop-collector` / `rfq-miner` / `public-sea` 三个功能本来就在同一个
-- CRX 安装包里（共用一份 download_key），拆成三条商品线是建模错误。
-- 现合并为 slug='alibaba-toolkit'（「外贸工具箱·国际站增强」），
-- 定价：划线原价 ¥39.9 / 限时特惠实付 ¥9.9。
--
-- 幂等：全部语句可重复执行（ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING）。
-- 未跑过旧版 0021 的库执行本文件为安全空操作（除插入新商品）。

-- ── 1. 新增三列（新库由 0021 建出，此处为老库补齐）────────────────────────
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS list_price_monthly_cents integer;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS promo_ends_at timestamptz;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS features text[];

-- ── 2. 插入合并后的商品（已存在则不改动，避免覆盖后台手改的定价）───────────
INSERT INTO plugins (
  slug, name, tagline, description, category,
  price_monthly_cents, list_price_monthly_cents, features, status, sort_order
) VALUES (
  'alibaba-toolkit',
  '外贸工具箱·国际站增强',
  '采集 / RFQ / 公海客户三合一，浏览器里直接干活，数据导出到 Excel',
  '一个扩展覆盖阿里国际站日常运营：竞品店铺产品批量采集、RFQ 商机挖掘、公海买家提取，全部支持一键导出。',
  '综合',
  990,
  3990,
  ARRAY[
    '店铺产品采集：列表页 / 详情页 / 运营台 / 榜单 / 搜索页一键抓取，导出 CSV / Excel',
    'RFQ 商机挖掘：实时抓取采购需求，一键导出跟进',
    '公海客户提取：海量买家公海池批量提取与导出'
  ],
  'active',
  1
)
ON CONFLICT (slug) DO NOTHING;

-- ── 3. 迁移旧订阅：已购用户的权益一秒都不能丢 ──────────────────────────────
-- 3a) 用户已有新商品订阅 → 把旧订阅里最晚的到期时间并进去（只顺延，不缩短）
UPDATE plugin_subscriptions n
SET expires_at = GREATEST(n.expires_at, o.max_exp)
FROM (
  SELECT s.user_id, MAX(s.expires_at) AS max_exp
  FROM plugin_subscriptions s
  JOIN plugins p ON p.id = s.plugin_id
  WHERE p.slug IN ('shop-collector', 'rfq-miner', 'public-sea')
  GROUP BY s.user_id
) o,
     plugins np
WHERE np.slug = 'alibaba-toolkit'
  AND n.user_id = o.user_id
  AND n.plugin_id = np.id;

-- 3b) 用户还没有新商品订阅 → 把旧订阅里最晚的一条改指向新商品
WITH np AS (
  SELECT id FROM plugins WHERE slug = 'alibaba-toolkit'
), pick AS (
  SELECT DISTINCT ON (s.user_id) s.id
  FROM plugin_subscriptions s
  JOIN plugins p ON p.id = s.plugin_id
  WHERE p.slug IN ('shop-collector', 'rfq-miner', 'public-sea')
    AND NOT EXISTS (
      SELECT 1 FROM plugin_subscriptions t
      WHERE t.user_id = s.user_id AND t.plugin_id = (SELECT id FROM np)
    )
  ORDER BY s.user_id, s.expires_at DESC
)
UPDATE plugin_subscriptions s
SET plugin_id = (SELECT id FROM np)
FROM pick
WHERE s.id = pick.id;

-- 3c) 清理残余旧订阅行（同一用户买过多条，有效期已在 3a 合并）
DELETE FROM plugin_subscriptions s
USING plugins p
WHERE s.plugin_id = p.id
  AND p.slug IN ('shop-collector', 'rfq-miner', 'public-sea');

-- ── 4. 旧 slug 下架（不删除：历史订单的 subject_id 仍引用它们）─────────────
UPDATE plugins
SET status = 'hidden', updated_at = now()
WHERE slug IN ('shop-collector', 'rfq-miner', 'public-sea')
  AND status <> 'hidden';
