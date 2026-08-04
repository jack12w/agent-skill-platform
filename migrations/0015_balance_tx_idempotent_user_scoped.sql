-- 重建余额流水幂等索引，加入 user_id。
--
-- 0014 建立的 idx_balance_tx_idempotent 定义为
--   (ref_id, biz_type, direction) WHERE ref_id IS NOT NULL
-- 缺少 user_id 维度，会导致两类资金漏洞：
--   ① 同一订单包含多个 item、且由同一卖家出售时，后续 item 的入账
--      (ref_id=order.id, biz_type='sale', direction='in') 与第一个 item 唯一碰撞
--      → INSERT 被 DO NOTHING 吞掉 → 该卖家少记收入（HIGH-1 的同源问题）。
--   ② 同一订单发生多次（部分）退款时，后续退款的扣回
--      (ref_id=order.id, biz_type='refund_deduct', direction='out') 与首次退款碰撞
--      → 后续退款的创作者扣回被吞掉 → 创作者少扣、平台多付（HIGH-2）。
--
-- 把 user_id 纳入唯一键后，组合更具体（只会减少碰撞，不会与既有数据冲突），
-- 上述两类场景各自拿到独立幂等键，彻底消除跨卖家/跨退款的误判。
--
-- 幂等：DROP IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS，可重复执行。
DROP INDEX IF EXISTS idx_balance_tx_idempotent;

CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_tx_idempotent
  ON balance_transactions (user_id, ref_id, biz_type, direction)
  WHERE ref_id IS NOT NULL;
