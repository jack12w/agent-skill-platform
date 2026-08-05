-- Migration 0016: 清理 0014 遗留的过宽余额流水幂等索引
--
-- 背景：
--   0014 曾建立 uq_balance_tx_ref(ref_id, biz_type, direction) WHERE ref_id IS NOT NULL，
--   该索引缺少 user_id 维度。0015 又建立了正确的
--   idx_balance_tx_idempotent(user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL，
--   但 0015 只 DROP 了同名（旧名）索引，并未 DROP 0014 的 uq_balance_tx_ref。
--
-- 后果（当前为潜伏性，非线上事故）：
--   若某环境先后应用了 0014 与 0015，则两索引并存。当前订单每行仅 1 个 item、
--   ref_id 全局唯一（order.id:item.id），两索引都不会被触发冲突，因此线上无影响。
--   但一旦未来出现「同一订单含多个同卖家 item」的多 item 订单，第二个 item 的
--   credit() INSERT 会同时撞上 uq_balance_tx_ref（不含 user_id）→ 抛 23505 唯一冲突，
--   而 ON CONFLICT 仅抑制 idx_balance_tx_idempotent 那一路，导致 deliver 永久抛错、
--   订单卡在 PAID 反复重试且买家拿不到权益。
--
-- 修复：幂等 DROP 遗留索引。未应用过 0014 的环境（仅 0015）DROP 为 no-op，安全可重跑。

DROP INDEX IF EXISTS uq_balance_tx_ref;
