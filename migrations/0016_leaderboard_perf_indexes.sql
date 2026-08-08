-- 0016: 排行榜聚合性能索引
-- 支撑 leaderboard.service 按 (status, owner_*, created_at) 做分组/过滤。
-- 周榜原先每次请求都对全量 published skills 现场 JOIN events 再按 7 天过滤；
-- 改造后改为读 skill_stats（不再扫 events），这两个组合索引进一步加速
-- skills 端的分组与「近 7 天上传」过滤。
-- 团队成员计数走 team_members（team_id 为主键前缀，已覆盖），无需额外索引。
-- 幂等，可安全补跑。

CREATE INDEX IF NOT EXISTS idx_skills_status_owner_user_created
  ON skills (status, owner_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_skills_status_owner_team_created
  ON skills (status, owner_team_id, created_at);
