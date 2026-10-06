-- 0029: search 类型改「按词去重更新」（一词一记录，重复词只更新数据）
--
-- 背景（2026-10-06 用户拍板）：关键词数据不是快照语义——同一个词反复搜索时，
-- 期望的是「更新该词的数据」而不是每次导出都多一份快照。
--
-- 机制（通用，不写死 search）：
--   ai_type_registry 新增 dedupe_key 列：非空 = 该类型按记录级「去重键」upsert——
--   push 时逐条记录取 records[i][dedupe_key] 作为业务身份，写入 ai_dataset.dedupe_val，
--   命中部分唯一索引 → ON CONFLICT DO UPDATE 原地更新（payload/时间/版本）；
--   query 时该类型不再按 collected_at 分快照，返回全部词的最新数据（分页）。
--
-- 内容：
--   1. ai_dataset 加 dedupe_val varchar(255) NULL（NULL = 普通快照行，不受影响）；
--   2. 部分唯一索引 uq_ai_dataset_dedupe (user_id, vendor_slug, type, dedupe_val)
--      WHERE dedupe_val IS NOT NULL —— 同用户同站点同类型同词仅一行；
--   3. ai_type_registry 加 dedupe_key varchar(32) NOT NULL DEFAULT ''（''=快照语义）；
--   4. search 种子启用 dedupe_key='keyword'（与插件 search.js 导出行字段名一致）。
--
-- 存量兼容：现网尚无 search 数据（B3 刚发版），无需回填；普通快照类型 dedupe_val
-- 保持 NULL，唯一键 uq_ai_dataset_snap（0028）不受影响。user_id 一律 uuid（勿改）。
-- 幂等：全部语句可重复执行。

-- ── 1. ai_dataset.dedupe_val ──────────────────────────────
ALTER TABLE ai_dataset ADD COLUMN IF NOT EXISTS dedupe_val varchar(255);

-- ── 2. 词级部分唯一索引（词级 upsert 的冲突目标）──────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_dataset_dedupe
  ON ai_dataset (user_id, vendor_slug, type, dedupe_val)
  WHERE dedupe_val IS NOT NULL;

-- ── 3. 注册表 dedupe_key ─────────────────────────────────
ALTER TABLE ai_type_registry ADD COLUMN IF NOT EXISTS dedupe_key varchar(32) NOT NULL DEFAULT '';

-- ── 4. search 启用按 keyword 去重 ─────────────────────────
UPDATE ai_type_registry SET dedupe_key = 'keyword'
  WHERE type = 'search' AND dedupe_key = '';
