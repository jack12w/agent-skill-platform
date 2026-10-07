-- 0030: growth/public_customer/gold/rank 四类型切「按业务键更新」语义（2026-10-07 用户拍板）
--
-- 背景：查询契约（REST/MCP）对快照类型永远只返回最新 collectedAt 一份快照（snapshotId 除外），
--       按日期推的每日快照除了最新那份全是只写不读的沉没存储（growth 280 条 ≈ 289KB/天/用户）。
--       0029 的词级 upsert 通用路径（push 端按注册表 dedupe_key 二分 + query 端 SQL 分页）已上线，
--       本迁移只改注册表数据即可完成语义切换，代码零改动。
--
-- 语义口径（实体状态类 → 更新；时点/行为流类 → 保持快照）：
--   growth          productId     商品表是「现状」数据，AI 分析要全量最新状态
--   public_customer customerId    客户实体，状态会变（认领/回收），最新状态最有价值
--   gold            dk            组合键 类目|工厂身份（companyId→factoryUrl→company 回落，
--                                 插件端 payload 组装时写入 records[i].dk，后端不感知组合逻辑）
--   rank            dk            组合键 榜ID|类目|商品ID（跨榜/跨类目同名次互不覆盖）
--   visitors/rfq    （不动）      行为流/商机流，快照本身带时间维度，历史即明细
--   search          （不动）      0029 已按 keyword upsert
--
-- 内容：
--   1. 注册表 dedupe_key：'' → 业务键（push 端 upsert / query 端「全部记录最新状态」自动生效）；
--   2. 切换类型的历史快照行删除（dedupe_val IS NULL = 快照行）。0030 起 query 端 dedupe 分支
--      会过滤 dedupe_val IS NOT NULL（同 commit），此处删除防四类旧快照永久滞留成死数据。
--      ⚠️ 前置：ai-query.service.ts 的 dedupe_val 过滤需随后部署（窗口期内旧快照会混入查询结果）。
--
-- user_id 一律 uuid（勿改）。幂等：全部语句可重复执行。

-- ── 1. 注册表切 dedupe_key ─────────────────────────────────
UPDATE ai_type_registry SET dedupe_key = 'productId'  WHERE type = 'growth'          AND dedupe_key = '';
UPDATE ai_type_registry SET dedupe_key = 'customerId' WHERE type = 'public_customer' AND dedupe_key = '';
UPDATE ai_type_registry SET dedupe_key = 'dk'         WHERE type IN ('gold', 'rank')  AND dedupe_key = '';

-- ── 2. 删除四类型历史快照行（dedupe_val IS NULL = 快照行；词级行 dedupe_val 非空不受影响） ──
DELETE FROM ai_dataset WHERE type IN ('growth', 'public_customer', 'gold', 'rank') AND dedupe_val IS NULL;
