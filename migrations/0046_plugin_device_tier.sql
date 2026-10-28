-- 0046：设备行记录「占用哪一档订阅」+ 团队行席位回填
--
-- 背景（2026-10-29 定案）：
--   0042「一档一行」之后，用户在同一插件族内可以持有**多行**订阅
--   （基础版 / Pro / 试用 / Team 专业版各一行）。但 `plugin_devices` 只有
--   (user_id, plugin_id, device_id)，设备到底是靠哪一档授权进来的**没有记录**：
--     · 设备上限只能拿「一个标量」估算（旧实现取主插件 max_activations = 1），
--       于是「买了基础版 + Pro 应该有 2 台」永远做不到；
--     · 账号页解绑后无法说清「释放的是哪一档的名额」。
--
--   本次为设备行补 `subscription_id`（指向 plugin_subscriptions.id），
--   口径定为「一档一台」：
--     个人行 → 1 台
--     团队行 → max_devices_per_member（默认 1，是「每人几台」，不是 seats）
--
--   同时把历史上 team_id 非空 / tier='team' 但 seats 为空的行的席位数按商品
--   `max_activations`（界面名「可授权账号数」）回填 —— 新的 tier 判据是
--   「可授权账号数 > 1 即团队」，seats 为空会让老团队行被误判成个人版而掉 AI。
--
-- 向后兼容：本迁移**只加列 + 回填**，不删列、不改类型，旧代码不读这一列，
--   所以可以「先跑迁移、再部署新代码」，不存在 0042 那种删列窗口。
--
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / 回填只写 NULL。

\set ON_ERROR_STOP on

-- ── 1. 设备行加归属列 ──────────────────────────────────────────────
ALTER TABLE plugin_devices
  ADD COLUMN IF NOT EXISTS subscription_id uuid;

CREATE INDEX IF NOT EXISTS idx_plugin_devices_sub
  ON plugin_devices (subscription_id);

-- 外键：订阅行全站不删除（退款只置 expired），ON DELETE SET NULL 只是防御
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_plugin_devices_sub'
  ) THEN
    ALTER TABLE plugin_devices
      ADD CONSTRAINT fk_plugin_devices_sub
      FOREIGN KEY (subscription_id) REFERENCES plugin_subscriptions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── 2. 回填设备归属（三档优先，只写 NULL 的行）─────────────────────
-- 2a) 优先：本人在期内、到期最晚的**个人**行
UPDATE plugin_devices d
   SET subscription_id = pick.sub_id
  FROM (
    SELECT DISTINCT ON (d2.id) d2.id AS dev_id, s.id AS sub_id
      FROM plugin_devices d2
      JOIN plugin_subscriptions s
        ON s.root_plugin_id = d2.plugin_id
       AND s.team_id IS NULL
       AND s.user_id = d2.user_id
       AND s.status IN ('active', 'cancelled')
       AND s.expires_at > now()
     WHERE d2.revoked_at IS NULL
       AND d2.subscription_id IS NULL
     ORDER BY d2.id, s.expires_at DESC
  ) pick
 WHERE d.id = pick.dev_id;

-- 2b) 其次：本人在册团队的、在期内到期最晚的团队行
UPDATE plugin_devices d
   SET subscription_id = pick.sub_id
  FROM (
    SELECT DISTINCT ON (d2.id) d2.id AS dev_id, s.id AS sub_id
      FROM plugin_devices d2
      JOIN plugin_subscriptions s
        ON s.root_plugin_id = d2.plugin_id
       AND s.team_id IS NOT NULL
       AND s.status IN ('active', 'cancelled')
       AND s.expires_at > now()
       AND EXISTS (
             SELECT 1 FROM team_members m
              WHERE m.team_id = s.team_id AND m.user_id = d2.user_id)
     WHERE d2.revoked_at IS NULL
       AND d2.subscription_id IS NULL
     ORDER BY d2.id, s.expires_at DESC
  ) pick
 WHERE d.id = pick.dev_id;

-- 2c) 兜底：只剩过期行的用户（历史设备仍要能说清归属，到期最晚者）
UPDATE plugin_devices d
   SET subscription_id = pick.sub_id
  FROM (
    SELECT DISTINCT ON (d2.id) d2.id AS dev_id, s.id AS sub_id
      FROM plugin_devices d2
      JOIN plugin_subscriptions s
        ON s.root_plugin_id = d2.plugin_id
       AND (
             (s.team_id IS NULL AND s.user_id = d2.user_id)
             OR (s.team_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM team_members m
                    WHERE m.team_id = s.team_id AND m.user_id = d2.user_id))
           )
     WHERE d2.revoked_at IS NULL
       AND d2.subscription_id IS NULL
     ORDER BY d2.id, s.expires_at DESC
  ) pick
 WHERE d.id = pick.dev_id;

-- ── 3. 团队行席位回填（tier 判据从 seats 读，不能为空）─────────────
-- 只补空值，不覆盖运营手工加过的席位（只升不降的既有约定）。
-- 取值顺序：商品「可授权账号数」(max_activations) → 商品 team_seats → 3。
UPDATE plugin_subscriptions s
   SET seats = GREATEST(1, COALESCE(p.max_activations, p.team_seats, 3))
  FROM plugins p
 WHERE p.id = s.plugin_id
   AND (s.team_id IS NOT NULL OR s.tier = 'team')
   AND s.seats IS NULL;

UPDATE plugin_subscriptions s
   SET max_devices_per_member = 1
 WHERE s.team_id IS NOT NULL
   AND s.max_devices_per_member IS NULL;

-- ── 4. 统计（人工核对用）────────────────────────────────────────────
DO $$
DECLARE
  v_total int;
  v_linked int;
  v_unlinked int;
  v_team_rows int;
  v_team_no_seats int;
BEGIN
  SELECT COUNT(*) INTO v_total FROM plugin_devices WHERE revoked_at IS NULL;
  SELECT COUNT(*) INTO v_linked FROM plugin_devices
   WHERE revoked_at IS NULL AND subscription_id IS NOT NULL;
  v_unlinked := v_total - v_linked;
  SELECT COUNT(*) INTO v_team_rows FROM plugin_subscriptions WHERE team_id IS NOT NULL;
  SELECT COUNT(*) INTO v_team_no_seats FROM plugin_subscriptions
   WHERE team_id IS NOT NULL AND (seats IS NULL OR seats < 1);
  RAISE NOTICE '0046: 活跃设备 % 台，已归属 % 台，未归属 % 台（该用户已无任何订阅行为 0）',
    v_total, v_linked, v_unlinked;
  RAISE NOTICE '0046: 团队行 % 条，席位仍为空 % 条（应为 0）', v_team_rows, v_team_no_seats;
END $$;
