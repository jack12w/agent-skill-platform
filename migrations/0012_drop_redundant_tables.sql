-- 0012 清理支付系统废弃表
-- 业务已从「全平台会员收益池」改为「创作者会员制 + 支付即直入创作者余额」，
-- 以下表已无任何读写逻辑，直接删除。
-- 注意：保留 memberships（老全平台会员过渡表），仍有部分用户在免费续期期内。

DROP TABLE IF EXISTS membership_downloads;  -- 旧收益池去重，allocatePool 已删
DROP TABLE IF EXISTS settlements;           -- 结算快照，runSettlement 已改为返回 skipped
DROP TABLE IF EXISTS service_orders;        -- B 类服务交易托管预留，本期未使用
DROP TABLE IF EXISTS skill_manifests;       -- D 类技能 API 化预留，本期未使用
DROP TABLE IF EXISTS api_calls;             -- D 类 API 调用计量预留，本期未使用
