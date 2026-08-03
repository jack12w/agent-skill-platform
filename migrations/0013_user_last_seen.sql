-- 0013_user_last_seen.sql
-- 用户最近活跃时间：管理端用户列表的"最近访问"列 + 7/30/90/180/365 天活跃数统计
-- 幂等，可安全重复执行。

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NULL;

-- 活跃统计按 last_seen_at 范围过滤，用户量增长后需要索引
CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users (last_seen_at);
