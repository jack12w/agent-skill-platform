-- 0015_user_activity.sql
-- 登录用户活跃日志：每个登录用户每天一行（去重），作为
-- 7/30/90/180/365 天活跃用户统计的真实数据源。
-- 仅记录登录用户（user_id 来自有效 token / 登录），匿名访客不写入，
-- 彻底排除未登录数据进入用户管理统计。
-- 幂等，可安全重复执行。

CREATE TABLE IF NOT EXISTS user_daily_active (
  user_id uuid NOT NULL,
  day      date NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- day 单列索引，供区间扫描（PK 已覆盖 (user_id, day) 查询）
CREATE INDEX IF NOT EXISTS idx_user_daily_active_day ON user_daily_active (day);

-- 历史回填：上线前无逐日日志，以注册日作为首日活跃，
-- 使各时间窗立即出现合理分布（而非全部堆积在 7 天那一档）。
INSERT INTO user_daily_active (user_id, day)
SELECT id, DATE(created_at) FROM users
ON CONFLICT (user_id, day) DO NOTHING;
