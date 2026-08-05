-- Migration 0017: balance_transactions.ref_id 类型 UUID → TEXT
--
-- 背景（资金/可用性 HIGH）：
--   BalanceTransaction 实体将 ref_id 定义为 uuid（payments.entity.ts），0010 迁移也将
--   该列建为 UUID。但业务代码传入的是**复合字符串**作为幂等键：
--     - BalanceService.credit：ref_id = `${order.id}:${item.id}`（形如 "uuid:uuid"，非合法 UUID）
--     - BalanceService.debitForRefund：ref_id = 退款单 id（合法 UUID，不受影响）
--   若生产库按当前 0010 DDL 确为 UUID，则每笔销售入账的 INSERT 会报
--   「invalid input syntax for type uuid」，导致 deliver() 永久抛错、订单卡在 PAID、
--   创作者余额永不增加（买家已拿到权益，但卖家分文未得，且前端轮询反复重试）。
--
-- 命中条件：库由「当前版 0010」迁移创建即触发；若历史某次 0010 曾为 TEXT（架构漂移），
-- 则该环境实际为 TEXT、暂未爆发，但全新部署会复发。无论哪种，都应统一为 TEXT。
--
-- 修复：改为 TEXT。唯一索引 idx_balance_tx_idempotent(user_id, ref_id, biz_type, direction)
--       对 TEXT 同样成立，幂等语义不变。USING ref_id::text 兼容列中已有 UUID 值。
-- 幂等：已是 TEXT 时 ALTER 为 no-op。可安全重复执行。

ALTER TABLE balance_transactions ALTER COLUMN ref_id TYPE text USING ref_id::text;
