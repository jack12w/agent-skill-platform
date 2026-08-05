-- 0010: 支付与分成系统地基 + 架构漂移修复
-- 全部使用 IF NOT EXISTS / 幂等 DO 块，可安全重复执行，不影响任何现有表与接口。
-- 部署：本文件需在服务器手动 psql 执行（部署命令 `up -d --build` 不自动跑迁移）。
--
-- 注：本文件已内含原 0014/0015/0016/0017 的全部修复（为保持首次部署历史干净而折入）：
--   * balance_transactions.ref_id 直接建为 TEXT（业务用 `${order.id}:${item.id}` 复合字符串做幂等键，非 UUID）；
--   * 余额流水幂等索引直接建为 idx_balance_tx_idempotent(user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL；
--   因此全新部署只需跑 0010→0013，无需再跑任何后续支付修复迁移。
--   DBUSER=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_USER')
--   DBNAME=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_DB')
--   docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0010_payment_system.sql

-- ============================================================
-- 一、修复架构漂移（与现有功能零耦合）
-- ============================================================

-- 漂移①：users.role 在 user.entity.ts 中存在（默认 'user'），但 schema.sql 的 users 表无此列。
--        从 schema.sql 全新建库会缺列 → 查询报错。补列，默认 'user'，与注册/登录分支一致。
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- 漂移②：skill_status 枚举在 schema.sql 仅 'published'/'archived'，缺 'pending'
--        （shared 枚举与 admin.service.ts:379 已引用 SkillStatus.PENDING）。
--        用 DO 块幂等补充，避免重复执行报「值已存在」。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'skill_status' AND e.enumlabel = 'pending'
  ) THEN
    ALTER TYPE skill_status ADD VALUE 'pending';
  END IF;
END $$;

-- 漂移③（代码层，见 auth.service.ts 微信登录分支）：JWT payload 漏传 role，
--        与注册/登录/合并分支不一致。修复在代码中，不在此 SQL。

-- ============================================================
-- 二、平台交易配置（原 admin.service.ts:316 getSettings 硬编码，建表后可配置化）
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 仅缺失时初始化默认配置（ON CONFLICT DO NOTHING 保证可重跑）
INSERT INTO platform_settings (key, value) VALUES
  ('commission_rate_bp',    '1000'::jsonb),                                  -- 平台抽成 10%
  ('settlement_delay_days', '7'::jsonb),                                     -- 结算冻结期
  ('withdraw_min_cents',    '2000'::jsonb),                                  -- 最低提现 20 元
  ('membership_prices',     '{"monthly":2900,"quarterly":7900,"yearly":26800}'::jsonb)  -- 月/季/年（分）
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 三、A 类支付相关表（P0：买断 + 会员订阅）
-- ============================================================

-- 商品定价（挂在技能上）
CREATE TABLE IF NOT EXISTS skill_pricing (
  skill_id              UUID PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  pricing_mode          TEXT NOT NULL DEFAULT 'free',   -- free|paid|member_only|both
  price_cents           BIGINT NOT NULL DEFAULT 0,
  member_included       BOOLEAN NOT NULL DEFAULT false, -- 会员可免费下载
  commercial_price_cents BIGINT NOT NULL DEFAULT 0,     -- 商用授权价（P1 双档用）
  currency              TEXT NOT NULL DEFAULT 'CNY',
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 订单
CREATE TABLE IF NOT EXISTS orders (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no                   TEXT UNIQUE NOT NULL,
  user_id                    UUID NOT NULL REFERENCES users(id),
  type                       TEXT NOT NULL,            -- skill|membership
  status                     TEXT NOT NULL DEFAULT 'CREATED',
  total_cents                BIGINT NOT NULL DEFAULT 0,
  paid_cents                 BIGINT NOT NULL DEFAULT 0,
  refunded_cents             BIGINT NOT NULL DEFAULT 0,
  commission_rate_bp_snapshot INTEGER NOT NULL DEFAULT 1000,  -- 费率快照，改费率不影响历史单
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  paid_at                    TIMESTAMPTZ,
  closed_at                  TIMESTAMPTZ,
  expire_at                  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_no   ON orders(order_no);

-- 订单项（下单即算好分成金额，不复算）
CREATE TABLE IF NOT EXISTS order_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  subject_type       TEXT NOT NULL,             -- skill|membership
  subject_id         UUID,
  seller_user_id     UUID REFERENCES users(id),
  unit_cents         BIGINT NOT NULL DEFAULT 0,
  qty                INTEGER NOT NULL DEFAULT 1,
  commission_cents   BIGINT NOT NULL DEFAULT 0,
  seller_income_cents BIGINT NOT NULL DEFAULT 0,
  snapshot           JSONB                      -- 商品名/版本/封面，防下架后订单异常
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- 支付流水
CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'wechat',
  trade_type    TEXT NOT NULL,                 -- NATIVE|JSAPI|H5
  out_trade_no  TEXT UNIQUE NOT NULL,
  transaction_id TEXT UNIQUE,
  amount_cents  BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  prepay_data   JSONB,
  paid_at       TIMESTAMPTZ,
  raw_notify    JSONB
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- 退款流水
CREATE TABLE IF NOT EXISTS refunds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id    UUID REFERENCES payments(id),
  out_refund_no TEXT UNIQUE NOT NULL,
  refund_id     TEXT,
  amount_cents  BIGINT NOT NULL DEFAULT 0,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  applied_by    UUID REFERENCES users(id),
  reviewed_by   UUID REFERENCES users(id),
  refunded_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

-- 微信回调日志（幂等 + 排障留证）
CREATE TABLE IF NOT EXISTS wechat_notify_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT,
  resource_id TEXT,
  raw_body    TEXT,
  processed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wechat_notify_resource ON wechat_notify_logs(resource_id);

-- 权益（付费墙判断依据）
CREATE TABLE IF NOT EXISTS entitlements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,                -- purchase|membership|author|gift
  license    TEXT NOT NULL DEFAULT 'personal',
  order_id   UUID REFERENCES orders(id),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ                   -- NULL=永久
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlements_user_skill_license
  ON entitlements(user_id, skill_id, license);
CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id);

-- 会员
CREATE TABLE IF NOT EXISTS memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan       TEXT NOT NULL,                -- monthly|quarterly|yearly
  status     TEXT NOT NULL DEFAULT 'active', -- active|expired|cancelled
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT false,
  order_id   UUID REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

-- ============================================================
-- 四、资金相关表（P0）
-- ============================================================

-- 创作者余额
CREATE TABLE IF NOT EXISTS creator_balances (
  user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_cents       BIGINT NOT NULL DEFAULT 0,
  frozen_cents          BIGINT NOT NULL DEFAULT 0,
  total_earned_cents    BIGINT NOT NULL DEFAULT 0,
  total_withdrawn_cents BIGINT NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 0   -- 乐观锁
);

-- 余额流水（复式，永不删改）
CREATE TABLE IF NOT EXISTS balance_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL,         -- in|out
  amount_cents       BIGINT NOT NULL DEFAULT 0,
  balance_after_cents BIGINT NOT NULL DEFAULT 0,
  biz_type           TEXT NOT NULL,         -- sale|membership_share|refund_deduct|withdraw|adjust
  ref_id             TEXT,                  -- 复合幂等键(如 order.id:item.id)，故为 TEXT 而非 UUID
  remark             TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_tx_user ON balance_transactions(user_id);

-- 余额流水幂等索引（防并发双入账兜底）：直接建最终正确形态。
-- 原 0014/0015/0016/0017 的修补已折入本文件，全新部署即此形态。
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_tx_idempotent
  ON balance_transactions (user_id, ref_id, biz_type, direction)
  WHERE ref_id IS NOT NULL;

-- 提现申请
CREATE TABLE IF NOT EXISTS withdrawals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents  BIGINT NOT NULL DEFAULT 0,
  fee_cents     BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|REVIEWING|PAID|FAILED|CANCELLED
  channel       TEXT NOT NULL DEFAULT 'wechat_transfer',
  target_openid TEXT,
  real_name     TEXT,
  out_bill_no   TEXT UNIQUE NOT NULL,
  transfer_bill_no TEXT,
  applied_at    TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ,
  fail_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);

-- 注：收益池时代的 membership_downloads / settlements 表已移除（业务改为创作者会员制，
-- 支付即直入创作者余额）。曾跑过旧版 0010 的环境可用 migrations/0012 清理这些历史表。
