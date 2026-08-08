-- 0017: 技能归属确定性治理（方案 A 根治）
-- 背景：skills.owner_user_id 长期为 NOT NULL，导致「团队技能」在编辑(PATCH)时
--       置空 owner_user_id 触发约束冲突 → 500；个人/团队本是「互斥归属(XOR)」，
--       团队技能本就无个人归属人，却被强行塞一个用户，归属语义混乱。
-- 目标：owner_user_id 与 owner_team_id 互斥；原创作者永久由 created_by 记录
--       （团队解散 / 解绑也不漂移，见 0014）。
-- 幂等，可安全补跑。

-- 1) 允许 owner_user_id 为空（团队技能无个人归属人）
ALTER TABLE skills ALTER COLUMN owner_user_id DROP NOT NULL;

-- 2) 回填：团队技能(owner_team_id 非空)一律清空 owner_user_id，落实 XOR。
--    created_by 已在 0014 回填，作者信息不丢；个人技能(owner_team_id 为空)保持不动。
UPDATE skills SET owner_user_id = NULL WHERE owner_team_id IS NOT NULL AND owner_user_id IS NOT NULL;

-- ── 回滚（如需）──
-- UPDATE skills SET owner_user_id = created_by WHERE owner_team_id IS NOT NULL AND owner_user_id IS NULL;
-- ALTER TABLE skills ALTER COLUMN owner_user_id SET NOT NULL;
