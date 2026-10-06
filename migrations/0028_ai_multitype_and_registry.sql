-- 0028: AI 数据服务多类型扩展（AI版/docs/计划-多类型扩展与看板优化.md v2.4 / T310）
--
-- 内容（四件事）：
--   1. ai_dataset 加 seq（分批推送批次序号；单批上限 5000 条/5MB，超限拆批）。
--   2. 存量 vendor_slug='' 补 'alibaba'（当前唯一插件线；信封缺省同值）。
--   3. 唯一键重建：uq_ai_dataset → (user_id, vendor_slug, type, range_days, collected_at, seq)
--      —— 原键不含 seq，分批的第 2 批起会被 dedup 丢数据；DO 块判存保证幂等可重跑。
--   4. 新建 ai_type_registry（类型注册表）：type 白名单由管理后台「插件数据→类型注册表」子 TAB
--      维护（增/改/删/停），未注册 type 推送 400 UNKNOWN_TYPE；enabled=false 拒新推可查历史。
--      种子 7 类 = 现有 visitors + 计划 1.2 表六类（rfq/gold/search/rank/growth/public_customer）。
--
-- user_id 一律 uuid（users.id 是 uuid，0026 同口径，勿改）。
-- 幂等：全部语句可重复执行。

-- ── 1. seq 列 ──────────────────────────────────────────────
ALTER TABLE ai_dataset ADD COLUMN IF NOT EXISTS seq integer NOT NULL DEFAULT 1;

-- ── 2. 存量 vendor 归线 ────────────────────────────────────
-- 现网插件信封 vendorSlug='alibaba-toolkit'（plugins.slug 兜底），0028 起 vendor 语义改为「站点线」
-- （alibaba/1688），与插件订阅判定用的 plugins.slug 解耦：存量两值一律归一为 'alibaba'。
UPDATE ai_dataset SET vendor_slug = 'alibaba' WHERE vendor_slug IS DISTINCT FROM 'alibaba'
  AND vendor_slug IN ('', 'alibaba-toolkit');

-- ── 3. 唯一键重建（DO 块判存；ADD CONSTRAINT 重复执行会报错）──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_ai_dataset_snap') THEN
    ALTER TABLE ai_dataset DROP CONSTRAINT IF EXISTS uq_ai_dataset;
    ALTER TABLE ai_dataset ADD CONSTRAINT uq_ai_dataset_snap
      UNIQUE (user_id, vendor_slug, type, range_days, collected_at, seq);
  END IF;
END $$;

-- ── 4. 类型注册表 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_type_registry (
  type       varchar(32) PRIMARY KEY,
  label      varchar(64) NOT NULL DEFAULT '',
  strict     boolean     NOT NULL DEFAULT false,
  enabled    boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ai_type_registry (type, label, strict) VALUES
  ('visitors',        '访客详情', true),
  ('rfq',             'RFQ',      false),
  ('gold',            '金牌工厂', false),
  ('search',          '关键词',   false),
  ('rank',            '热门爆款', false),
  ('growth',          '商品运营', false),
  ('public_customer', '公海客户', false)
ON CONFLICT (type) DO NOTHING;
