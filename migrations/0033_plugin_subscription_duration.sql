-- 0033：插件「订阅有效期（天）」默认字段
-- 依赖 0021（plugins 已建）。幂等可补跑。
--
-- 目的：把订阅默认时长从付费路径写死的 30 天（orders.service.ts 的 MONTH 常量）下沉为
--       插件级可配置字段：后台新增/编辑插件即可设定该款的订阅有效期；
--       付费开通（fulfillPluginSubscription）与后台手动开通（adminAddSubscription 默认天数）都以它为准。
-- 存量兼容：默认 30 天，与改动前的「包月 30 天」行为完全一致。
-- ⚠️ 生产库不自动跑迁移（synchronize=false）：先手工 psql 执行本文件，再上代码。
--    顺序反了不会立刻炸（新列在 adminCreate 里才写入），但后台表单提交会 500（列不存在）。

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS subscription_duration_days integer NOT NULL DEFAULT 30;

UPDATE plugins SET subscription_duration_days = 30
WHERE subscription_duration_days IS NULL OR subscription_duration_days < 1;
