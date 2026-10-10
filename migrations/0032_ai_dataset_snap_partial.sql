-- 0032：修复 AI 推送 dedupe 类型（message 等）多行批次 500
--
-- 现象（2026-10-10 生产实锤，api 日志）：
--   duplicate key value violates unique constraint "uq_ai_dataset_snap"
--   at AiPushController.push（⑧a 词级 upsert 路径）
-- 根因：
--   0028 把快照唯一键建成了**全表 UNIQUE 约束**（不带 WHERE）；
--   0029 的词级 upsert（dedupe_key 非空类型）一条语句插 N 行，每行快照键
--   (user_id, vendor_slug, type, range_days, collected_at, seq) 完全相同（seq 硬编码 1），
--   ON CONFLICT 只仲裁去重部分索引 ⇒ 第 2 行起撞 uq_ai_dataset_snap → 未捕获 → 500。
--   search 每批恒 1 条所以从未触发；message 一批 N 个客户必炸。
-- 修法：
--   快照唯一键改为**部分唯一索引** WHERE dedupe_val IS NULL —— 词级行（dedupe_val 非空）
--   不再受快照键约束，快照行语义不变（词级行的快照键本来就无意义）。
--   配套：ai-push.controller.ts ⑧b 的 ON CONFLICT 目标补 WHERE 谓词（与索引谓词逐字一致）；
--         ⑧a 入库前按去重键批内去重（同批重复键会让 ON CONFLICT DO UPDATE
--         报 21000 cannot affect row a second time，一并防御）。
-- 存量兼容：现存词级行（search）快照键彼此相同也无所谓——转部分索引后互不约束；
--   快照行（visitors/growth/gold 等 dedupe_val IS NULL）被新索引完整覆盖，幂等语义不变。
-- ⚠️ 必须在代码上线前执行（synchronize=false；新代码的 ON CONFLICT 目标带 WHERE 谓词，
--   若索引还是旧全表约束会直接报「no unique or exclusion constraint matching the
--   ON CONFLICT specification」→ 500）。

ALTER TABLE ai_dataset DROP CONSTRAINT IF EXISTS uq_ai_dataset_snap;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_dataset_snap
  ON ai_dataset (user_id, vendor_slug, type, range_days, collected_at, seq)
  WHERE dedupe_val IS NULL;
