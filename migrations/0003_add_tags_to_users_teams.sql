-- Migration 0003: 为 users / teams 增加 tags 字段（标签 TAB 功能）
-- 适用于已上线数据库（synchronize:false，需手动执行）
-- 在服务器数据库执行：psql "$DATABASE_URL" -f migrations/0003_add_tags_to_users_teams.sql

-- 用户标签
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tags TEXT[];
UPDATE users SET tags = '{}' WHERE tags IS NULL;

-- 团队标签
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS tags TEXT[];
UPDATE teams SET tags = '{}' WHERE tags IS NULL;
