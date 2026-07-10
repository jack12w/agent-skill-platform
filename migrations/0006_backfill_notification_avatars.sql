-- 0006_backfill_notification_avatars.sql
-- 回填旧订阅通知的 targetName / targetType / targetId / targetAvatar
-- 这些通知在 5d30c3b 之前产生，payload 里没有头像字段

BEGIN;

-- 1. 根据标题回填 targetName（兼容新旧两种标题格式）
-- 新格式：「王祭司 发布了新内容」
-- 旧格式：「你订阅的 王祭司 有 1 个新内容」
UPDATE notifications
SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('targetName', target_name)
FROM (
  SELECT id,
    CASE
      WHEN title ~ '^(.+) 发布了新内容$' THEN substring(title from '^(.+) 发布了新内容$')
      WHEN title ~ '你订阅的 (.+) 有' THEN substring(title from '你订阅的 (.+) 有')
      ELSE NULL
    END AS target_name
  FROM notifications
  WHERE type = 'subscription'
    AND (payload IS NULL OR payload->>'targetName' IS NULL)
) sub
WHERE notifications.id = sub.id
  AND sub.target_name IS NOT NULL;

-- 2. 根据 link 回填 targetType / targetId（用户：/users/{name}）
UPDATE notifications
SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
  'targetType', 'user',
  'targetId', u.id
)
FROM users u
WHERE notifications.type = 'subscription'
  AND notifications.link LIKE '/users/%'
  AND (notifications.payload IS NULL OR notifications.payload->>'targetType' IS NULL)
  AND u.name = notifications.payload->>'targetName';

-- 3. 根据 link 回填 targetType / targetId（团队：/teams/{id}）
UPDATE notifications
SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
  'targetType', 'team',
  'targetId', substring(link from '/teams/(.+)$')
)
WHERE type = 'subscription'
  AND link LIKE '/teams/%'
  AND (payload IS NULL OR payload->>'targetType' IS NULL);

-- 4. 回填用户头像
UPDATE notifications
SET payload = payload || jsonb_build_object('targetAvatar', u.avatar_url)
FROM users u
WHERE notifications.type = 'subscription'
  AND notifications.payload->>'targetType' = 'user'
  AND notifications.payload->>'targetId' = u.id
  AND (notifications.payload->>'targetAvatar' IS NULL OR notifications.payload->>'targetAvatar' = '');

-- 5. 回填团队头像（取 owner avatar_url 兜底）
UPDATE notifications
SET payload = payload || jsonb_build_object('targetAvatar', u.avatar_url)
FROM teams t
JOIN users u ON t.owner_user_id = u.id
WHERE notifications.type = 'subscription'
  AND notifications.payload->>'targetType' = 'team'
  AND notifications.payload->>'targetId' = t.id
  AND (notifications.payload->>'targetAvatar' IS NULL OR notifications.payload->>'targetAvatar' = '');

COMMIT;
