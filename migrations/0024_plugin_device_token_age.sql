-- 0024 设备令牌的绝对有效期（90 天天花板）
--
-- 背景（plugin-coupling-security-report.html 第 6 条）：plugin_devices 只有 revoked_at，
-- 没有签发时间。令牌的失效路径只有三条 —— 用户手动解绑 / 后台吊销 / 订阅失效，
-- 而订阅失效时令牌是**保留**的（续费即复活）。于是一份外泄的令牌在长期订阅下永久可用。
-- 本迁移加一列签发时间，服务端据此在 entitlement 里返回 REAUTH（插件会清令牌并要求重新授权），
-- 把最坏情况从「无限期」压到 90 天。
--
-- ⚠️ 部署顺序：必须在**代码上线之前**执行本文件。实体已声明该列且 synchronize=false，
--    库上没这一列时，poll/approve/entitlement/listDevices 都会因「column does not exist」500。
--
-- 幂等：可重复执行。

ALTER TABLE plugin_devices
  ADD COLUMN IF NOT EXISTS token_issued_at timestamptz;

-- 存量回填：已有令牌的行按 created_at 近似（宁可让老设备早一点到期，也不要留 NULL 永久豁免）
UPDATE plugin_devices
   SET token_issued_at = created_at
 WHERE token_hash IS NOT NULL
   AND token_issued_at IS NULL;

-- 未签发令牌的行（待激活 / 已吊销）保持 NULL：语义是「尚无有效令牌」，不参与有效期判定
UPDATE plugin_devices
   SET token_issued_at = NULL
 WHERE token_hash IS NULL
   AND token_issued_at IS NOT NULL;

-- 说明（不建索引）：token_issued_at 只在校验已定位到具体设备行之后做一次比较，
-- 不参与任何 WHERE 过滤，加索引没有收益。
