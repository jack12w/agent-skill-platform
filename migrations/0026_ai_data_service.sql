-- 0026 AI 数据服务：四张新表（方案 v2.1，AI版/docs/方案-AI数据服务.md §7.1）
--
-- 背景：插件把采集数据推上云端（POST /api/ai/data/push），后端存好、管好、计量好；
--       本迁移只建表，push/query/keys 业务接口由后续 AI 模块（T105/T301）实现。
--
-- 设计要点（v2.1 修订，2026-10-05）：
--   1. ai_dataset 唯一键 = (user_id, type, range_days, collected_at)，刻意**不含 source**：
--      同一份采集（手动/自动两条链路重推）视为同一份数据，去重而非双存。
--      服务端用 INSERT ... ON CONFLICT DO NOTHING 原子去重（禁止 SELECT-then-INSERT 竞态写法）。
--   2. source / vendor_slug / ext_ver 三列 DEFAULT ''：老版本插件不传也照收（向后兼容）。
--   3. ai_usage_event 记**成功+失败**全量调用（status），管理看板才有「调用成功/失败」统计。
--
-- ⚠️ 部署顺序：必须**先在生产库手工执行本文件**，再部署依赖这些表的代码（先表后码）。
--    docker initdb 只在全新卷首次初始化时按文件名顺序自动执行；已有卷需手工 psql。
--
-- 幂等：可重复执行（IF NOT EXISTS 全覆盖）。

-- ── 1. 数据集主表：插件推送的采集数据，payload 为 JSONB 原文（云端收到即可用，不再清洗）──
-- ⚠️ user_id 一律 uuid（users.id 是 uuid，与 0021/0022 同型）；方案文档 §7.1 初稿写 INTEGER 是笔误。
CREATE TABLE IF NOT EXISTS ai_dataset (
  id            BIGSERIAL PRIMARY KEY,
  user_id       uuid         NOT NULL,
  type          VARCHAR(32)  NOT NULL,              -- visitors | growth_risk | rfq_leads
  source        VARCHAR(32)  NOT NULL DEFAULT '',   -- manual | auto（SW 侧按 settings.autoCollect 判定）
  vendor_slug   VARCHAR(64)  NOT NULL DEFAULT '',   -- 信封 vendorSlug 落库（多插件线预留）
  ext_ver       VARCHAR(32)  NOT NULL DEFAULT '',   -- 插件版本（诊断坏数据来自哪个版本）
  range_days    INTEGER      NOT NULL DEFAULT 7,
  collected_at  TIMESTAMPTZ  NOT NULL,
  schema_ver    INTEGER      NOT NULL DEFAULT 1,
  count         INTEGER      NOT NULL DEFAULT 0,    -- records 条数（冗余，查询侧免解 JSONB）
  payload       JSONB        NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_dataset UNIQUE (user_id, type, range_days, collected_at)
);

-- 查询侧主路径：按用户+类型取最新数据集
CREATE INDEX IF NOT EXISTS idx_ai_dataset_q ON ai_dataset (user_id, type, collected_at DESC);

-- ── 2. 推送日志：push 全量留痕（含失败与重试终态），管理看板「推送成功/失败」数据源 ──
CREATE TABLE IF NOT EXISTS ai_push_log (
  id BIGSERIAL PRIMARY KEY,
  user_id uuid,
  status  VARCHAR(16) NOT NULL,          -- ok | rejected | error
  type    VARCHAR(32),
  bytes   INTEGER,
  error   TEXT,                          -- 只存契约错误信息/path，禁存 payload 原文与任何凭证
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. MCP/API 密钥：sha256 存储、明文仅生成时返回一次、可吊销 ──
CREATE TABLE IF NOT EXISTS ai_api_key (
  id BIGSERIAL PRIMARY KEY,
  user_id  uuid NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,  -- sha256 hex
  label    VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- ── 4. 查询计量：每次密钥调用留痕（成功+失败），未来多收益方分账的预留数据 ──
CREATE TABLE IF NOT EXISTS ai_usage_event (
  id BIGSERIAL PRIMARY KEY,
  user_id uuid NOT NULL,
  api_key_id BIGINT,
  type VARCHAR(32) NOT NULL,
  range_days INTEGER,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ok',   -- ok | rejected | error
  code   VARCHAR(32) NOT NULL DEFAULT '',     -- MEMBER_REQUIRED / NOT_FOUND / RATE_LIMITED / UNAUTHORIZED
  queried_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_q ON ai_usage_event (user_id, queried_at DESC);
