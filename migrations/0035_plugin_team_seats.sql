-- 0035：插件团队订阅席位制（Team = N 个账号，替代「1 账号 × N 设备」语义）
-- 依赖 plugin_subscriptions / teams / team_members 已建。幂等可补跑。
--
-- 模型（2026-10-12 拍板）：
--   1) 团队订阅行：plugin_subscriptions.team_id 非 NULL，user_id = 团长（购买者），
--      权益覆盖该团队全部在册成员（team_members 实时校验，移除成员即失权）
--   2) 个人订阅行：team_id IS NULL，行为与 0035 之前完全一致
--   3) seats = 席位数（含团长）；max_devices_per_member = 每成员设备上限（下单快照，默认 1）
--   4) plugins.team_seats = 团队档商品含席位数（后台按款配置）
-- ⚠️ 唯一约束变更：原 UNIQUE(user_id, plugin_id) 会挡住「团长同时持有个人订阅 + 团队订阅」，
--    改为部分唯一索引 UNIQUE(user_id, plugin_id) WHERE team_id IS NULL（个人行仍全局唯一）。
-- ⚠️ 生产库不自动跑迁移：先手工 psql 执行本文件，再上代码（顺序反了团队发放/解析会 500）。

-- ── plugin_subscriptions 新列 ──
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams (id);
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS seats integer;
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS max_devices_per_member integer;
CREATE INDEX IF NOT EXISTS plugin_subscriptions_team_id_idx ON plugin_subscriptions (team_id);

-- ── 唯一约束替换（按列定位约束名，TypeORM 生成的名字带随机哈希，不能写死） ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute a1 ON a1.attrelid = con.conrelid AND a1.attnum = con.conkey[1]
      JOIN pg_attribute a2 ON a2.attrelid = con.conrelid AND a2.attnum = con.conkey[2]
     WHERE con.conrelid = 'plugin_subscriptions'::regclass
       AND con.contype = 'u'
       AND a1.attname = 'user_id'
       AND a2.attname = 'plugin_id'
  LOOP
    EXECUTE format('ALTER TABLE plugin_subscriptions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_subs_user_plugin_personal
  ON plugin_subscriptions (user_id, plugin_id)
  WHERE team_id IS NULL;

-- ── plugins：团队档含席位数（NULL = 该款无团队档概念） ──
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS team_seats integer;
