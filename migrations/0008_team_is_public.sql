-- 0008: 团队「对外展示」开关
-- 开启（默认）：所有用户可查看并下载该团队技能
-- 关闭：仅团队成员（含 owner）可查看并下载

BEGIN;

ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;

COMMIT;
