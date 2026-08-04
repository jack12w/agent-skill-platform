-- 0014 余额流水幂等索引（防并发双入账兜底）
--
-- 背景：deliver / finalizeRefund 的入账(credit)/冲正(debitForRefund) 已按
-- (ref_id, biz_type) 做"先查后插"去重，但查与插之间非原子。在「前端轮询触发
-- 的 syncFromWechat」与「微信回调 handleNotify」并发进入同一订单发货时，两路
-- 可能同时查到"无重复"并各自插入 → 创作者余额被重复入账（资金安全事故）。
--
-- 解决：对 balance_transactions 加「ref_id 非空」的部分唯一索引，把幂等保证
-- 下沉到数据库层，彻底杜绝并发双插。代码层 try/catch 吞掉唯一冲突错误即可。
--
-- 幂等、可安全重复执行（CREATE UNIQUE INDEX IF NOT EXISTS）。

CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_tx_ref
  ON balance_transactions (ref_id, biz_type, direction)
  WHERE ref_id IS NOT NULL;
