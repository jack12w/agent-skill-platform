-- 0037: plugin 团唯一约束 + 团队订阅行唯一约束（2026-10-12 质检）。
--
-- 背景（席位制并发缺陷，用户拍板「现在就加」）：
--  ① ensureOwnerTeam 是 findOne→save 的无锁两步：两笔团队订单回调并发时各建一个
--     plugin 团（teams 无唯一约束），成员名单分裂（加到 A 团的成员不吃 B 团订阅）。
--  ② plugin_subscriptions 的团队行无唯一约束（0035 的部分唯一索引只覆盖个人行）：
--     两笔并发回调可插两行同 (user, plugin) 的团队订阅。
--
-- 两个索引都是「有才建」+ 重复数据时打 NOTICE 跳过（不阻塞部署，转人工处理）：
-- 生产当前仅 1 个 plugin 团（用户自购），数据干净，正常路径直接建成。

DO $$
BEGIN
  BEGIN
    -- 一个 owner 最多一个 plugin 专属团（skills 团 kind='skill' 不受限）
    CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_owner_plugin
      ON teams (owner_user_id) WHERE kind = 'plugin';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'duplicate plugin teams exist; uq_teams_owner_plugin skipped - dedupe manually';
  END;

  BEGIN
    -- 同一用户同一插件的团队订阅行唯一（个人行由 0035 的部分唯一索引管）
    CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_subs_user_plugin_team
      ON plugin_subscriptions (user_id, plugin_id) WHERE team_id IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'duplicate team subscription rows exist; uq_plugin_subs_user_plugin_team skipped - dedupe manually';
  END;
END $$;
