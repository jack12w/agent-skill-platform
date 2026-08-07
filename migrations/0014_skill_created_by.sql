-- 0014: 钉死技能原创作者 (created_by)
-- 目的：技能支持「个人 XOR 团队」独占归属后，挂团队时 owner_user_id 会被清空；
--       解绑团队时若直接回填「当前操作者」会导致归属漂移（团队成员解绑后技能归他）。
--       新增 created_by 永久记录原始创建者，解绑团队时回填它。

-- 1) 新增列（幂等）
ALTER TABLE skills ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

-- 2) 回填旧数据：以 owner_user_id 作为原创作者；团队技能 owner_user_id 为 NULL 的保持 NULL。
UPDATE skills SET created_by = owner_user_id WHERE created_by IS NULL;

-- ── 回滚（如需）──
-- UPDATE skills SET created_by = NULL WHERE created_by IS NOT NULL;
-- ALTER TABLE skills DROP COLUMN created_by;
