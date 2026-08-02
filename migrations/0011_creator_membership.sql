-- Migration 0011: 创作者会员制（替代"全平台会员收益池"）
-- 在服务器数据库执行：psql "$DATABASE_URL" -f migrations/0011_creator_membership.sql
-- 幂等，可安全重复执行。
--
-- 说明：
--   原 memberships 是"全平台统一会员"，月底把会费均分给 ≤30 个创作者（收益池）。
--   现改为"创作者会员"：每个 user/team 自行设置月/季/年三档价格，用户订阅某创作者后
--   在订阅期内可免费下载 TA 的全部技能（含更新）。订阅费直接进创作者余额，取消收益池均分。
--   老全平台会员作为过渡：免费续 1 个月，过渡期内仍可下载 member_included 技能（不计收益池）。

-- 创作者会员定价（每 user/team 一套）
CREATE TABLE IF NOT EXISTS creator_membership_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type    TEXT NOT NULL,              -- user | team
  target_id      UUID NOT NULL,
  monthly_cents  INTEGER NOT NULL DEFAULT 0, -- 0 = 该档未开通
  quarterly_cents INTEGER NOT NULL DEFAULT 0,
  yearly_cents   INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'CNY',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_cmp_target ON creator_membership_plans(target_type, target_id);

-- 创作者会员订阅记录
CREATE TABLE IF NOT EXISTS creator_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 订阅者
  target_type   TEXT NOT NULL,              -- user | team
  target_id     UUID NOT NULL,              -- 创作者 user_id 或 team_id
  plan          TEXT NOT NULL,              -- monthly | quarterly | yearly
  price_cents   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  status        TEXT NOT NULL DEFAULT 'active', -- active | expired | cancelled
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  order_id      UUID REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_cs_user ON creator_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_cs_target ON creator_subscriptions(target_type, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_user_target
  ON creator_subscriptions(user_id, target_type, target_id);

-- 过渡：老全平台会员免费续 1 个月（仅对仍有效者），过渡期内仍可下载会员技能。
-- 收益池分配（allocatePool）已下线，故老会员下载不再给创作者分成，属一次性过渡补偿。
UPDATE memberships
   SET expires_at = expires_at + INTERVAL '1 month'
 WHERE status = 'active' AND expires_at > NOW();
