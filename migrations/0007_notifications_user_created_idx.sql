-- 0007 为 notifications 增加 (user_id, created_at) 复合索引
-- 加速站内通知列表查询（铃铛），避免随通知量增长而变慢。
-- 注意：synchronize=false，需手动执行本迁移。

BEGIN;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

COMMIT;
