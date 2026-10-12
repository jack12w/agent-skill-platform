-- 0034：插件订阅邀请推广（推荐归因）体系
-- 依赖 users / orders / order_items 已建。幂等可补跑。
--
-- 模型（2026-10-12 拍板）：
--   1) users.referral_code      每人一个邀请码，懒生成（首次打开邀请页才生成），存量用户零迁移
--   2) users.referred_by        被谁邀请；注册（邮箱）或登录后补绑（微信）时绑定一次，终身不变
--   3) 归因快照                  不动 orders 表结构：下单时把买家 referred_by 写进
--                               order_items.snapshot->>'referrer_id'（jsonb），历史归因不可变
--   4) referral_rewards         佣金表（本期只建不写）：佣金暂不自动入账，按订单人工月结；
--                               表结构与唯一约束先就位，二期写入时无需再迁移
-- 防刷规则： referred_by 一次绑定不可覆盖；微信补绑仅限「注册 7 天内」的账号；不能自邀。
-- ⚠️ 生产库不自动跑迁移：先手工 psql 执行本文件，再上代码（顺序反了注册接口会 500）。

-- ── 邀请码 ──
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code varchar(12);
-- 普通 UNIQUE 索引即可：PG 唯一索引天然允许多个 NULL（未生成的存量用户互不冲突）
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_key ON users (referral_code);

-- ── 归因绑定 ──
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES users (id);
CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users (referred_by);

-- ── 佣金表（预留，本期不写入） ──
CREATE TABLE IF NOT EXISTS referral_rewards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL,
  referrer_id   uuid NOT NULL,
  invitee_id    uuid NOT NULL,
  amount_cents  bigint NOT NULL DEFAULT 0,
  rate_bp       integer NOT NULL DEFAULT 2000,           -- 2000 = 20%
  status        varchar(20) NOT NULL DEFAULT 'PENDING',  -- PENDING | PAID | CANCELLED
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_rewards_order_id_key UNIQUE (order_id)
);
