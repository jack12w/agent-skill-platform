-- 插件市场：商品目录 + 用户包月订阅
-- 幂等可补跑；不改动任何旧表。
--
-- 2026-09-26 修订：商品模型从「3 条独立商品」改为「1 个商品 + 3 个功能」。
-- 原因：三个功能本来就在同一个 CRX 里（共用一份 download_key），
-- 正确模型是 1 个商品 + N 个 feature，而不是 3 个商品。
-- 若你的库已经跑过本文件的旧版本（已插入 3 条 slug），
-- 请继续跑 0023_plugin_toolkit_merge.sql 完成合并。

CREATE TABLE IF NOT EXISTS plugins (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      text NOT NULL UNIQUE,
  name                      text NOT NULL,
  tagline                   text,
  description               text,
  icon_url                  text,
  category                  text NOT NULL DEFAULT '通用',
  price_monthly_cents       integer NOT NULL DEFAULT 0,
  -- 划线原价（分）。NULL 或 <= 实付价 = 不展示划线价
  list_price_monthly_cents  integer,
  -- 促销截止；NULL = 促销静态生效（不自动回价，后台手工改）
  promo_ends_at             timestamptz,
  -- 商品含的功能点（纯展示）
  features                  text[],
  currency                  text NOT NULL DEFAULT 'CNY',
  status                    text NOT NULL DEFAULT 'active',
  sort_order                integer NOT NULL DEFAULT 0,
  download_key              text,
  download_filename         text,
  owner_team_id             uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- 索引（slug 已有 UNIQUE 隐含索引；补充排序/查询）
CREATE INDEX IF NOT EXISTS idx_plugins_status_sort ON plugins (status, sort_order);

CREATE TABLE IF NOT EXISTS plugin_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  plugin_id    uuid NOT NULL,
  plan         text NOT NULL DEFAULT 'monthly',
  price_cents  integer NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'CNY',
  status       text NOT NULL DEFAULT 'active',
  started_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  order_id     uuid,
  UNIQUE (user_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_subs_user ON plugin_subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_plugin_subs_plugin ON plugin_subscriptions (plugin_id);

-- 初始上架 1 个商品（下载文件上线时在 /hub/plugins 补填 download_key）
-- 定价：划线原价 ¥39.9 / 限时特惠实付 ¥9.9
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
