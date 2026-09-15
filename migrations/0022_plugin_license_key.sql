-- 插件订阅卡密（license key）：每订阅一条稳定密钥，续费只顺延有效期、卡密不变。
-- 幂等可补跑；不改动任何旧表结构（仅 plugin_subscriptions 加一列）。

ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS license_key text;

-- 部分唯一索引：仅对非空值生效，允许历史 NULL 行共存。
DROP INDEX IF EXISTS uq_plugin_subs_license;
CREATE UNIQUE INDEX uq_plugin_subs_license
  ON plugin_subscriptions (license_key)
  WHERE license_key IS NOT NULL;

-- 回填：对已存在的订阅（预期为空，phase1 未部署无数据）补一个随机卡密，避免 NULL。
-- 新订阅一律在履约时由应用层生成 grouped 格式 SD-XXXX-XXXX-XXXX-XXXX；此处仅兜底。
UPDATE plugin_subscriptions
SET license_key = 'SD-' || upper(replace(gen_random_uuid()::text, '-', ''))
WHERE license_key IS NULL;
