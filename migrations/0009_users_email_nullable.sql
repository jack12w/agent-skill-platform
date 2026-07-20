-- Phase 1: 支持微信登录用户无邮箱
-- 目标：email 允许为空（微信用户初始无邮箱），并新增 email_verified 标记，
--       区分「已验证真实邮箱」与「未绑定/占位邮箱」，为订阅邮件门禁（Phase 3）提供依据。

-- 1) email 允许为空。Postgres 唯一约束允许多个 NULL，故置 NULL 不会与唯一索引冲突。
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- 2) 新增 email_verified 标记，默认 true（历史邮箱用户视为已验证）。
--    微信新建用户会在应用层写为 false（见 Phase 2 的 wechatCallback 改造）。
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;

-- 3) 清洗历史占位微信邮箱（wx_xxx@wechat.local / wx_mock_xxx@wechat.local），
--    改为 NULL + 未验证，使订阅邮件门禁能正确跳过、且不向死地址发信。
--    这些账号原本就无法用该邮箱登录/收信，置 NULL 不影响任何现有功能。
UPDATE users SET email = NULL, email_verified = false WHERE email LIKE 'wx%@wechat.local';

-- ── 回滚（如需）──
-- 先把 NULL 的微信用户邮箱回填为占位值，再删列、恢复非空：
-- UPDATE users
--   SET email = 'wx_' || substr(coalesce(wechat_openid, ''), 1, 12) || '@wechat.local',
--       email_verified = true
--   WHERE email IS NULL AND wechat_openid IS NOT NULL;
-- ALTER TABLE users DROP COLUMN email_verified;
-- ALTER TABLE users ALTER COLUMN email SET NOT NULL;  -- 需先确保无 NULL 行
