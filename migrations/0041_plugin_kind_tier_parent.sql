-- 0041: 插件商品「类型 / 档位归属 / 限购 / 禁续费」+ 修复试用商品权益落错行
--
-- 背景（2026-10-28 生产事故）：
--   运营在后台手工新建「新用户试用」商品时把 slug 填成了 `7testing`。权益映射判据
--   `isMainPluginTierSlug()` 依赖 slug 前缀 `alibaba-toolkit-`，于是：
--     · 试用订单的订阅行落在**试用商品自己的 id** 上（没映射回主行）
--     · 扩展端 auth_core.js 写死 DEFAULT_SLUG='alibaba-toolkit'，entitlement 只按
--       device.plugin_id（主行）解析 → 读到的是用户那条**已过期的基础版**
--       → 插件弹「基础版已过期」，用户买了试用却用不了
--     · 市场页/账号页按各自 plugin_id 索引 → 显示「新用户试用 正常，未绑定设备」
--   ⇒ 同一份数据两条读取路径给出相反答案。
--
-- 修复策略：
--   1. 把「是不是某个插件的档位/试用」从**slug 命名约定**升级为**显式字段** parent_plugin_id，
--      运营以后随便起 slug 也不会再坏（slug 前缀退化为兜底）。
--   2. 商品类型 kind：standard=独立商品 / tier=价格档位 / trial=试用。
--   3. 限购 max_purchases_per_user + 禁续费 renew_allowed（试用预设 1 次 / 不可续费）。
--   4. 把已经落错行的订阅行**合并**回主行（不是 0039 的「冲突就跳过」——本例用户
--      主行有过期基础版行，跳过等于永远修不好）。
--
-- 幂等：所有 DDL 用 IF NOT EXISTS；数据修复用 DO 块 + 状态重置，可重复执行。

-- ─────────────────────────── 1. 表结构 ───────────────────────────

ALTER TABLE plugins ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS parent_plugin_id UUID;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS max_purchases_per_user INT;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS renew_allowed BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_plugins_kind') THEN
    ALTER TABLE plugins ADD CONSTRAINT ck_plugins_kind
      CHECK (kind IN ('standard', 'tier', 'trial'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_plugins_parent') THEN
    ALTER TABLE plugins ADD CONSTRAINT fk_plugins_parent
      FOREIGN KEY (parent_plugin_id) REFERENCES plugins(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_plugins_purchase_limit') THEN
    ALTER TABLE plugins ADD CONSTRAINT ck_plugins_purchase_limit
      CHECK (max_purchases_per_user IS NULL OR max_purchases_per_user >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plugins_parent ON plugins(parent_plugin_id);
-- 限购校验按 (用户, 商品) 统计已支付订单，没有这个索引会全表扫 orders
CREATE INDEX IF NOT EXISTS idx_order_items_subject ON order_items(subject_type, subject_id);

-- ─────────────────────────── 2. 回填 parent_plugin_id ───────────────────────────

DO $$
DECLARE
  main_id UUID;
BEGIN
  SELECT id INTO main_id FROM plugins WHERE slug = 'alibaba-toolkit';
  IF main_id IS NULL THEN
    RAISE NOTICE '0041: 主插件行 alibaba-toolkit 不存在，跳过回填';
    RETURN;
  END IF;

  -- 已知档位族（年付 Pro / 企业版 Team）：slug 前缀能认出来的，回填显式字段
  UPDATE plugins
     SET kind = 'tier',
         parent_plugin_id = main_id
   WHERE parent_plugin_id IS NULL
     AND slug LIKE 'alibaba-toolkit-%'
     AND slug <> 'alibaba-toolkit';

  -- 「新用户试用」：slug 是运营随手填的 7testing，必须靠名称/价格特征识别并改名。
  -- 改名后 isMainPluginTierSlug 的 slug 前缀兜底也能认得它（双保险）。
  UPDATE plugins
     SET slug = 'alibaba-toolkit-trial',
         kind = 'trial',
         parent_plugin_id = main_id,
         max_purchases_per_user = 1,
         renew_allowed = FALSE
   WHERE slug = '7testing';

  RAISE NOTICE '0041: 回填完成';
END $$;

-- ─────────────────────────── 3. 合并落错行的订阅到主行 ───────────────────────────
--
-- 规则（与 orders.fulfillPluginSubscription 的一行制模型对齐）：
--   · 目标行 = 主插件行上的「同用户 + 同归属形态（个人/团队）」订阅行
--   · 目标不存在  → 直接把 plugin_id 改成主行
--   · 目标已存在  → 合并：以「到期更晚」的那行为权益基准（status/expires_at/started_at/
--                   order_id/price_cents/source_plugin_id 一并取过去），
--                   另一行保留但置 status='expired'（不删：订阅行是财务溯源凭证）
--   · 合并后 source_plugin_id 必须指向档位商品 id —— 账号中心/订阅卡片按它显示档位名，
--     否则用户会看到「新用户试用」变成了「基础版」
DO $$
DECLARE
  main_id  UUID;
  rec      RECORD;
  tgt_id   UUID;
  tgt_exp  TIMESTAMPTZ;
  src_exp  TIMESTAMPTZ;
  moved    INT := 0;
  merged   INT := 0;
BEGIN
  SELECT id INTO main_id FROM plugins WHERE slug = 'alibaba-toolkit';
  IF main_id IS NULL THEN
    RAISE NOTICE '0041: 主插件行不存在，跳过订阅合并';
    RETURN;
  END IF;

  FOR rec IN
    SELECT s.id, s.user_id, s.team_id, s.status, s.expires_at, s.started_at,
           s.order_id, s.price_cents, s.plugin_id
      FROM plugin_subscriptions s
      JOIN plugins p ON p.id = s.plugin_id
     WHERE s.plugin_id <> main_id
       AND (p.parent_plugin_id = main_id OR p.slug LIKE 'alibaba-toolkit-%')
     ORDER BY s.expires_at DESC
  LOOP
    -- 找目标行（同用户 + 同归属形态）
    IF rec.team_id IS NULL THEN
      SELECT id, expires_at INTO tgt_id, tgt_exp
        FROM plugin_subscriptions
       WHERE user_id = rec.user_id AND plugin_id = main_id AND team_id IS NULL
       LIMIT 1;
    ELSE
      SELECT id, expires_at INTO tgt_id, tgt_exp
        FROM plugin_subscriptions
       WHERE user_id = rec.user_id AND plugin_id = main_id AND team_id IS NOT NULL
       LIMIT 1;
    END IF;

    IF tgt_id IS NULL THEN
      -- 无冲突：直接迁到主行，同时补上购买档位溯源
      UPDATE plugin_subscriptions
         SET plugin_id = main_id,
             source_plugin_id = COALESCE(source_plugin_id, rec.plugin_id)
       WHERE id = rec.id;
      moved := moved + 1;
      CONTINUE;
    END IF;

    -- 有冲突：比较到期时间，更晚的一方成为权益基准
    src_exp := rec.expires_at;
    IF src_exp > COALESCE(tgt_exp, '-infinity'::timestamptz) THEN
      UPDATE plugin_subscriptions
         SET status         = CASE WHEN rec.status IN ('active', 'cancelled') THEN rec.status ELSE status END,
             expires_at     = rec.expires_at,
             started_at     = rec.started_at,
             order_id       = COALESCE(rec.order_id, order_id),
             price_cents    = rec.price_cents,
             source_plugin_id = rec.plugin_id
       WHERE id = tgt_id;
      -- 被合并的那行降级为历史行，不再参与权益解析（不删）
      UPDATE plugin_subscriptions SET status = 'expired' WHERE id = rec.id;
      merged := merged + 1;
      RAISE NOTICE '0041: 合并 sub=% 到主行 sub=%（取更晚到期）', rec.id, tgt_id;
    ELSE
      -- 主行到期更晚或相同 → 权益基准仍是主行那一行，只把档位/试用行归档为历史行。
      --
      -- ⚠️ 这里**绝对不能**吸收 rec.plugin_id 当 source_plugin_id（2026-10-28 自查修正）：
      --    0040 里 source_plugin_id 的语义是「本行权益**最近一次**发放依据的商品」。
      --    此刻权益依据是主行原本那次购买，不是这次试用。一旦写成试用商品 id：
      --      · 账号中心按 source 渲染卡片 → 显示「新用户试用」
      --      · 试用商品 renew_allowed=false → 续费按钮被前端收掉
      --      · 后端禁续费拦截也会因「族内有订阅行」直接拒单
      --    ⇒ 一个基础版还有 20 天、只是顺手买过试用的付费用户，会突然找不到续费入口。
      UPDATE plugin_subscriptions SET status = 'expired' WHERE id = rec.id;
      merged := merged + 1;
      RAISE NOTICE '0041: 主行 sub=% 到期更晚，sub=% 仅归档（不改主行权益依据）', tgt_id, rec.id;
    END IF;
  END LOOP;

  RAISE NOTICE '0041: 订阅归位完成，直接迁移 % 行，合并 % 行', moved, merged;
END $$;

-- 核对语句（人工执行）：
--   1) 应无任何订阅行落在档位/试用商品上：
--      SELECT p.slug, COUNT(*) FROM plugin_subscriptions s JOIN plugins p ON p.id = s.plugin_id
--       WHERE p.slug LIKE 'alibaba-toolkit-%' AND p.slug <> 'alibaba-toolkit' GROUP BY p.slug;
--   2) 商品类型分布：
--      SELECT slug, kind, parent_plugin_id, max_purchases_per_user, renew_allowed FROM plugins ORDER BY sort_order;
