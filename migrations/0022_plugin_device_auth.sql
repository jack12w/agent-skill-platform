-- 0022 插件设备授权登录（替代原卡密模型）
-- 依赖 0021（plugins / plugin_subscriptions 已建）。幂等可补跑。
-- 不改动任何旧表结构，仅给 plugins 加一列 + 建两张新表。
--
-- 模型：插件首次使用发起授权 → 用户在网页确认 → 平台签发「设备令牌」。
-- 令牌明文永不落库（只存 sha256），且仅在轮询响应中出现一次。

-- 1) 每插件允许同时激活的设备数（商品属性，后台可改；默认 2：主用 + 备用）
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS max_activations integer NOT NULL DEFAULT 2;

UPDATE plugins SET max_activations = 2
WHERE max_activations IS NULL OR max_activations < 1;

-- 2) 设备授权记录：一行 = 一台已授权设备，可逐台吊销。
-- 之所以用表而非订阅上的 text[]：数组无法单独吊销一台、无法记最后活跃、并发激活会互相覆盖。
CREATE TABLE IF NOT EXISTS plugin_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plugin_id uuid NOT NULL,
  device_id text NOT NULL,
  -- sha256(设备令牌)；NULL = 已批准但插件尚未取走令牌
  token_hash text,
  device_name text,
  platform text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_devices_uid_pid_did
  ON plugin_devices (user_id, plugin_id, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_devices_token
  ON plugin_devices (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plugin_devices_plugin
  ON plugin_devices (plugin_id);

-- 3) 授权请求（设备码流程）：插件发起 → 用户网页确认 → 插件轮询取令牌。
CREATE TABLE IF NOT EXISTS plugin_auth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  -- sha256(轮询凭据)：没有它，仅凭 8 位码猜中就能劫走别人的设备令牌
  poll_secret_hash text NOT NULL,
  plugin_id uuid,
  device_id text NOT NULL,
  device_name text,
  platform text,
  -- pending=待确认 approved=已确认 denied=已拒绝
  status text NOT NULL DEFAULT 'pending',
  user_id uuid,
  -- 被拒/失败原因，透传给插件端做可操作提示：
  -- NO_SUBSCRIPTION | EXPIRED_SUBSCRIPTION | ACTIVATION_LIMIT | USER_DENIED
  deny_reason text,
  -- 非 NULL = 令牌已下发过，不可再下发（防重放）
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_auth_req_code
  ON plugin_auth_requests (code);
CREATE INDEX IF NOT EXISTS idx_plugin_auth_req_expires
  ON plugin_auth_requests (expires_at);
