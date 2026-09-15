-- 插件市场：商品目录 + 用户包月订阅
-- 幂等可补跑；不改动任何旧表。

CREATE TABLE IF NOT EXISTS plugins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE,
  name                text NOT NULL,
  tagline             text,
  description         text,
  icon_url            text,
  category            text NOT NULL DEFAULT '通用',
  price_monthly_cents integer NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'CNY',
  status              text NOT NULL DEFAULT 'active',
  sort_order          integer NOT NULL DEFAULT 0,
  download_key        text,
  download_filename   text,
  owner_team_id       uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
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

-- 初始上架 3 个平台插件（价格由平台设定，可随时改；download_key 上线时补填）
INSERT INTO plugins (slug, name, tagline, description, category, price_monthly_cents, status, sort_order)
VALUES
  ('rfq-miner', 'RFQ 挖掘助手', '自动抓取阿里国际站 RFQ 商机，智能匹配高意向采购需求', '实时 RFQ 订阅与过滤、买家画像与匹配度评分、一键转客户跟进。', '客户开发', 9900, 'active', 1),
  ('public-sea', '公海客户', '海量买家公海池，一键挖掘并同步至你的 CRM', '千万级买家数据库、多维筛选与导出、自动去重与跟进提醒。', '客户开发', 12900, 'active', 2),
  ('shop-collector', '店铺产品采集', '批量采集竞品店铺商品数据，生成选品与定价参考', '整店商品批量采集、价格/销量趋势分析、CSV/Excel 一键导出。', '数据采集', 7900, 'active', 3)
ON CONFLICT (slug) DO NOTHING;
