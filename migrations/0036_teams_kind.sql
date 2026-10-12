-- 0036: 团队用途隔离（2026-10-12 用户拍板）。
--
-- 背景：0035 的自动建团（ensureOwnerTeam）按「owner 已有团就复用」策略，把插件
-- 团队订阅挂到了用户此前为 **skills 协作** 建的团上（实测：买了团队版被挂到
-- 「盛世TEAM」），导致 skills 团队成员被动获得插件权益。
-- 用户拍板：skills 团队与插件团队**彻底分开**，插件发放只认/只建插件专属团。
--
-- 方案：teams 加 kind 列（'skill' | 'plugin'，默认 'skill' 存量全归 skills）；
-- ensureOwnerTeam 只复用 kind='plugin' 的团。同时把存量「插件团队订阅行挂在
-- skill 团上」的数据迁到为团长新建的 plugin 专属团（幂等，可重复执行）。

ALTER TABLE teams ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'skill';

DO $$
DECLARE
  rec RECORD;
  new_team_id uuid;
  owner_name text;
BEGIN
  -- 存量修复：凡插件团队订阅行（plugin_subscriptions.team_id 非空）指向的团是
  -- kind='skill'，就为该团长建一个 plugin 专属团（名字「{名字}的插件团队」），
  -- 并把该团长的插件团队订阅行全部迁过去。迁移后原 skill 团成员自动失去插件权益
  -- （权益解析按订阅行 team_id → team_members 实时查询，不再经过旧团）。
  FOR rec IN
    SELECT DISTINCT s.user_id, s.team_id
      FROM plugin_subscriptions s
      JOIN teams t ON t.id = s.team_id
     WHERE s.team_id IS NOT NULL AND t.kind = 'skill'
  LOOP
    SELECT name INTO owner_name FROM users WHERE id = rec.user_id;

    SELECT id INTO new_team_id
      FROM teams
     WHERE owner_user_id = rec.user_id AND kind = 'plugin'
     LIMIT 1;

    IF new_team_id IS NULL THEN
      INSERT INTO teams (name, description, owner_user_id, is_public, kind, created_at, updated_at)
      VALUES (COALESCE(owner_name, '我的') || '的插件团队', NULL, rec.user_id, false, 'plugin', now(), now())
      RETURNING id INTO new_team_id;

      INSERT INTO team_members (team_id, user_id, role, joined_at)
      VALUES (new_team_id, rec.user_id, 'owner', now());
    END IF;

    UPDATE plugin_subscriptions
       SET team_id = new_team_id
     WHERE team_id = rec.team_id AND user_id = rec.user_id;
  END LOOP;
END $$;
