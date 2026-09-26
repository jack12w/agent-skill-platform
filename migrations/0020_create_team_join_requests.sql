-- 0020 团队加入申请表（公开申请 + owner 审批）
-- 与「按邮箱邀请」并列的第二种加成员方式。
-- 角色/状态用 varchar（不引用 member_role PG 枚举类型，避免类型名不确定性），取值在应用层校验。
-- 幂等可重复执行（IF NOT EXISTS）。
CREATE TABLE IF NOT EXISTS team_join_requests (
  team_id    UUID        NOT NULL,
  user_id    UUID        NOT NULL,
  role       VARCHAR(20) NOT NULL DEFAULT 'viewer',
  status     VARCHAR(10) NOT NULL DEFAULT 'pending',
  message    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_join_requests_team_status
  ON team_join_requests (team_id, status);
