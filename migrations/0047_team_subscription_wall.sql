-- 0047 团队订阅墙：套餐售卖状态 + 立即释放 + 存量订阅回填成员
-- 幂等：ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING，可重复执行。
-- 无破坏性 UPDATE：不改历史 skill_pricing、不删任何行、不改任何现有值。
-- 部署顺序：先在数据库执行本迁移，再部署新代码（新增列先于代码读取）。

-- 1) 套餐状态：enabled 只控制「是否接受新购/续费」；released_at 非空表示团长主动立即释放。
--    存量行默认 enabled=true（保持现状，上线不中断在售套餐）。
ALTER TABLE creator_membership_plans
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS enabled_before_release BOOLEAN NULL;

--    enabled_before_release：团长「立即释放」时记录释放前的 enabled，供 24h 内撤销精确回滚。
--    避免撤销后把原本「停售」的团队隐式改回「售卖中」。NULL = 从未释放 / 历史行。

-- 2) 存量有效团队订阅者补齐「团队成员」身份（仅可见性/协作，不参与下载权益判定）。
--    ON CONFLICT DO NOTHING 保证：已是成员（含 owner/maintainer）一律不降级、不覆盖。
--    仅回填「当前仍有效」的付费订阅；过期/退款用户不自动加入。
INSERT INTO team_members (team_id, user_id, role, joined_at)
SELECT cs.target_id, cs.user_id, 'viewer', now()
  FROM creator_subscriptions cs
  JOIN teams t ON t.id = cs.target_id
 WHERE cs.target_type = 'team'
   AND cs.status = 'active'
   AND cs.expires_at > now()
ON CONFLICT (team_id, user_id) DO NOTHING;
