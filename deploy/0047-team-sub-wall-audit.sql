-- 0047 团队订阅墙 · 阶段 0 只读盘点（生产 psql 执行）
-- 全部为 SELECT，不写库、不改任何数据。执行前先确认连的是生产库。
-- 用法: psql "$DATABASE_URL" -f diagnostic-0047-team-sub-wall.sql

-- 1) 存量有效团队订阅（迁移 0047 会回填这些人为 team_members VIEWER）
SELECT count(*) AS active_team_subscriptions
  FROM creator_subscriptions
 WHERE target_type = 'team' AND status = 'active' AND expires_at > now();

-- 2) 有套餐的团队：私有团队 / 停售 / 已释放 分别多少
SELECT
  count(*) AS plans_total,
  count(*) FILTER (WHERE t.is_public = false) AS private_teams_with_plan,
  count(*) FILTER (WHERE p.enabled = false) AS stopped_plans,
  count(*) FILTER (WHERE p.released_at IS NOT NULL) AS released_plans
  FROM creator_membership_plans p
  LEFT JOIN teams t ON t.id = p.target_id
 WHERE p.target_type = 'team';

-- 3) 私有团队且已有套餐（已有套餐仍可改价/停售/释放；仅「首次开套餐」会被 400 拦）
SELECT p.target_id, t.name, t.is_public, p.enabled, p.released_at
  FROM creator_membership_plans p
  JOIN teams t ON t.id = p.target_id
 WHERE p.target_type = 'team' AND t.is_public = false;

-- 4) 团队技能的定价行分布（判定层完全不读，仅用于确认历史脏数据规模）
SELECT s.owner_team_id IS NOT NULL AS is_team_skill,
       sp.pricing_mode,
       count(*) AS rows,
       count(*) FILTER (WHERE sp.price_cents < 100) AS below_min_sell
  FROM skill_pricing sp
  JOIN skills s ON s.id = sp.skill_id
 GROUP BY 1, 2 ORDER BY 1, 2;

-- 5) 缺 snapshot.plan 的创作者会员订单（退款无法精确回退，会走「保守整行失效 + 日志」）
SELECT count(*) AS orders_missing_plan
  FROM order_items
 WHERE subject_type = 'creator_membership'
   AND (snapshot->>'plan') IS NULL;

-- 6) 历史单买过团队技能的用户（永久权益，判定矩阵里已保留放行）
SELECT count(*) AS team_skill_purchases
  FROM entitlements e
  JOIN skills s ON s.id = e.skill_id
 WHERE s.owner_team_id IS NOT NULL;

-- 7) 存量 package_url 的 host 分布：不一致会导致 getObjectKeyFromUrl 反解失败
SELECT split_part(package_url, '/', 3) AS host, count(*)
  FROM skill_versions
 GROUP BY 1 ORDER BY 2 DESC;

-- 8) 有效订阅者中还不是团队成员的人数（迁移回填将新增的行数）
SELECT count(*) AS will_be_backfilled
  FROM creator_subscriptions cs
 WHERE cs.target_type = 'team' AND cs.status = 'active' AND cs.expires_at > now()
   AND NOT EXISTS (
     SELECT 1 FROM team_members tm
      WHERE tm.team_id = cs.target_id AND tm.user_id = cs.user_id
   );

-- 9) 迁移执行后的核对（跑完 0047 再执行这一段）
SELECT
  (SELECT count(*) FROM creator_membership_plans
    WHERE enabled = true AND released_at IS NULL) AS active_plans,
  (SELECT count(*) FROM team_members WHERE role = 'viewer') AS viewer_members,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'creator_membership_plans'
      AND column_name IN ('enabled','released_at','enabled_before_release')) AS new_columns,
  (SELECT count(*) FROM creator_membership_plans
    WHERE released_at IS NOT NULL) AS released_plans;

-- 10) 0047 上线前必须人工处置：停售 / 已释放团队下仍存在的待支付订阅订单。
--     新代码的 createOrder 前置门禁只拦「新下单/复用」，这些存量 PENDING_PAY 单
--     若被用户支付仍会发货（钱货两清），需运营决定：主动关单或通知用户。
SELECT o.order_no, o.user_id, o.paid_cents, o.expire_at,
       p.enabled, p.released_at, i.subject_id AS target_id
  FROM orders o
  JOIN order_items i ON i.order_id = o.id
  -- 用 subject_id 而非 snapshot->>'targetId'：避免对脏快照做 ::uuid 强转报错，
  -- 且 p.target_type='team' 天然排除 user 目标订阅。
  JOIN creator_membership_plans p
    ON p.target_type = 'team' AND p.target_id::text = i.subject_id
 WHERE o.status = 'PENDING_PAY' AND o.type = 'creator_membership'
   AND (p.enabled = false OR p.released_at IS NOT NULL)
 ORDER BY o.created_at DESC;

-- 11) 历史「团队技能单买」待支付单：新前置门禁已拦住复用，存量单仍需人工关单。
SELECT o.order_no, o.user_id, o.paid_cents, o.expire_at, s.name AS skill_name
  FROM orders o
  JOIN order_items i ON i.order_id = o.id
  JOIN skills s ON s.id = i.subject_id
 WHERE o.status = 'PENDING_PAY' AND o.type = 'skill'
   AND s.owner_team_id IS NOT NULL
 ORDER BY o.created_at DESC;

-- 12) 生产实际唯一约束核对：0011 建表含 UNIQUE(target_type,target_id)。
--     若结果为空说明生产缺约束（实体声明 unique 但 synchronize:false 不会补建），
--     此时判定 SQL 的 LIMIT 1 可能取到任意行，必须先人工去重再上线。
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'creator_membership_plans' AND indexdef ILIKE '%UNIQUE%';
