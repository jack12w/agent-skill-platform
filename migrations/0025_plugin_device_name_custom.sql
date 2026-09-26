-- 0025 设备名「用户自定义」标记
--
-- 背景：device_name 由插件端自动上报（`系统 · 浏览器 · 分辨率 · 时区`），每次 approve 都会
-- 用请求里的新值覆盖。用户如果手动改过名字（「办公室台式机」这种），下一次重新授权
-- 或续费后改名就被冲掉了 —— 用户视角就是「我改的名字自己变回去了」。
--
-- 本迁移加一个布尔标记：为 true 时，服务端**不再**用客户端上报值覆盖 device_name。
-- 语义与「令牌保留」同源：用户显式做过的操作，后续流程不得静默回滚。
--
-- ⚠️ 部署顺序：必须在**代码上线之前**执行本文件。实体已声明该列且 synchronize=false，
--    库上没这一列时，listDevices / approve / entitlement 都会因「column does not exist」500。
--
-- 幂等：可重复执行。

ALTER TABLE plugin_devices
  ADD COLUMN IF NOT EXISTS name_custom boolean NOT NULL DEFAULT false;

-- 存量行全部为 false：迁移前的名字都是客户端上报的，没有被用户改过。
-- 显式回填只是为了在「列刚加上但 DEFAULT 未生效」的极端情况下也不留 NULL
-- （NOT NULL DEFAULT 本就会回填，这里是防御性冗余，代价为零）。
UPDATE plugin_devices
   SET name_custom = false
 WHERE name_custom IS NULL;

-- 说明（不建索引）：name_custom 只在已定位到具体设备行后做一次布尔判断，
-- 不参与任何 WHERE 过滤 / 排序，加索引没有收益。
