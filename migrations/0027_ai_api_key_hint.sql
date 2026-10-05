-- 0027: ai_api_key 加 key_hint（掩码展示用：明文只在生成时返回一次，之后界面只能显示
-- 「ai_sk_••••后4位」。0026 只存 sha256 无法回显，必须落一份无泄露风险的提示位）。
-- 幂等；生产手工 psql（先表后码：先于 T301 代码部署）。

ALTER TABLE ai_api_key ADD COLUMN IF NOT EXISTS key_hint VARCHAR(12) NOT NULL DEFAULT '';
