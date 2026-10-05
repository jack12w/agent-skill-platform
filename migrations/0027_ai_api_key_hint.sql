-- 0027: ai_api_key 加 key_hint（掩码展示用：明文只在生成时返回一次，之后界面只能显示
-- 「ai_sk_••••后4位」。0026 只存 sha256 无法回显，必须落一份无泄露风险的提示位）。
-- 幂等；生产手工 psql（先表后码：先于 T301 代码部署）。

ALTER TABLE ai_api_key ADD COLUMN IF NOT EXISTS key_hint VARCHAR(12) NOT NULL DEFAULT '';

-- 复审修复（P0-2）：query 接口对「密钥无效/已吊销」的 401 尝试也要留痕，但此时拿不到
-- user_id（null）。0026 把 user_id 设成 NOT NULL 会让这条留痕插入静默失败——恰好把
-- 「密钥被扫/令牌试探」这条最重要的审计路径漏掉。放开 NOT NULL（重复执行幂等）。
ALTER TABLE ai_usage_event ALTER COLUMN user_id DROP NOT NULL;
