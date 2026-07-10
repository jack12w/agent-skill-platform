-- Migration 0005: 为通知表增加 payload 列，用于结构化存储订阅通知的技能列表
-- 在服务器数据库执行：psql "$DATABASE_URL" -f migrations/0005_add_notification_payload.sql

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS payload JSONB;
