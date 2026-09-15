-- 0023 插件订阅卡密防复用：设备激活绑定
-- 依赖 0021（plugin_subscriptions 表）与 0022（license_key 列）已执行。

-- 允许同时激活的设备数（默认 2：主用 + 备用/重装）
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS max_activations integer NOT NULL DEFAULT 2;

-- 已绑定的设备指纹列表（TEXT 数组，空数组表示尚未激活任何设备）
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS activated_devices text[] NOT NULL DEFAULT ARRAY[]::text[];

-- 历史数据兜底：若某些记录 max_activations 因默认值缺失为 0，统一归正为 2
UPDATE plugin_subscriptions
  SET max_activations = 2
  WHERE max_activations IS NULL OR max_activations < 1;
