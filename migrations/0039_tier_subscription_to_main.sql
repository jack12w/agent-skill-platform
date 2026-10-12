-- 0039: 把「档位商品」上的插件订阅行迁回主插件行（2026-10-12 四轮质检，数据修复）。
--
-- 背景（高危）：
--   后台「插件管理」允许运营手工新建商品。除企业版 `alibaba-toolkit-b2b` 外，
--   线上还有 `alibaba-toolkit-year`（Pro 标准版 ¥499/年）这类**同一插件的价格档位**。
--   而代码里原先只硬编码了 `-b2b` 一个档位映射，其余档位的订单会把订阅行落在
--   **档位商品自己的 id** 上：
--     · 扩展端 auth_core.js 写死 DEFAULT_SLUG='alibaba-toolkit'，设备注册/权益校验
--       只用 `device.plugin_id`（= 主插件行）去解析（PluginsAuthService.entitlement）
--     · AI 门禁 ai-query.service.ts 也只读主插件行
--   ⇒ 用户付了 ¥499，扩展端与 AI 门禁都查不到订阅 → 付费后无权益；
--     而市场页因为 `subs[档位商品id]` 命中而显示「已订阅」→ 用户看到自相矛盾的结果。
--
-- 代码侧已修（isMainPluginTierSlug / tierOfTierSlug，orders.service.ts）。
-- 本迁移负责把**历史上已经落错行**的数据搬回主行，否则老订单永远修不好。
--
-- 幂等 & 保守：
--   · 只搬 `plugin_subscriptions.plugin_id` 指向「档位商品」的行；
--   · 只搬**不产生唯一冲突**的行（目标主行上同 (user, 团队/个人) 已有订阅则跳过）；
--   · 跳过的一律 RAISE NOTICE，不删任何行、不做合并 —— 订阅行是财务溯源凭证。
--   · 可安全重复执行。

DO $$
DECLARE
  main_id UUID;
  rec     RECORD;
  moved   INT := 0;
  skipped INT := 0;
BEGIN
  SELECT id INTO main_id FROM plugins WHERE slug = 'alibaba-toolkit';
  IF main_id IS NULL THEN
    RAISE NOTICE '0039: 主插件行 alibaba-toolkit 不存在，跳过（无需迁移）';
    RETURN;
  END IF;

  -- 遍历所有「档位商品」（slug 形如 alibaba-toolkit-*，但不是主行本身）上的订阅行
  FOR rec IN
    SELECT s.id, s.user_id, s.tier, s.team_id
      FROM plugin_subscriptions s
      JOIN plugins p ON p.id = s.plugin_id
     WHERE p.slug LIKE 'alibaba-toolkit-%'
       AND p.slug <> 'alibaba-toolkit'
       AND s.plugin_id <> main_id
  LOOP
    -- 冲突检查：主插件行上是否已有「同用户 + 同团队归属形态」的订阅行
    IF rec.team_id IS NULL THEN
      PERFORM 1 FROM plugin_subscriptions
        WHERE user_id = rec.user_id AND plugin_id = main_id AND team_id IS NULL;
    ELSE
      PERFORM 1 FROM plugin_subscriptions
        WHERE user_id = rec.user_id AND plugin_id = main_id AND team_id IS NOT NULL;
    END IF;

    IF FOUND THEN
      skipped := skipped + 1;
      RAISE NOTICE '0039: 跳过 sub=% （主行上已有同用户同归属形态的订阅，需人工核对）', rec.id;
      CONTINUE;
    END IF;

    -- 迁到主行。企业版档位 → tier='team'；其余档位保持原样（个人）。
    UPDATE plugin_subscriptions
       SET plugin_id = main_id
     WHERE id = rec.id;
    moved := moved + 1;
  END LOOP;

  RAISE NOTICE '0039: 档位订阅迁回主行完成，迁移 % 行，跳过 % 行（跳过项见上方 NOTICE）', moved, skipped;
END $$;

-- 核对语句（人工执行，确认没有残留）：
--   SELECT p.slug, COUNT(*) FROM plugin_subscriptions s JOIN plugins p ON p.id = s.plugin_id
--    WHERE p.slug LIKE 'alibaba-toolkit-%' AND p.slug <> 'alibaba-toolkit' GROUP BY p.slug;
