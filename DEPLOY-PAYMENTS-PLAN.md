# 支付系统生产部署方案一（一次性补齐）

> 生成日期：2026-08-05｜适用：当前 main 分支（截至 commit de46a32）
> 用途：把近 3 天全部支付相关改动 + 前端优化，**首次**一次性部署到生产。
> 本文档是部署的**唯一权威来源**，覆盖此前散落在对话/报告里的所有步骤。

---

## 0. 核查结论（部署前必读）

| 项 | 状态 |
|---|---|
| 近 3 天支付改动（约 40 commits） | ✅ 已全部 `commit` + `push` 到 `main` |
| 生产是否已部署过任何支付代码/表 | ❌ **从未部署**（0010–0015 均"待执行"） |
| Git 工作区 | ✅ 干净，无未提交改动 |
| 部署命令是否自动跑迁移 | ❌ 不会（`synchronize:false`，无 `migrationsRun`）→ **迁移必须手动 psql 执行** |
| 容器名 | db=`agent_platform_db`，api=`agent_platform_api` |
| 当前 DB 连接池 | `extra.max=30`（另有 `poolSize=20`，生效 30）已 ≥20，无需调 |

**关键推论**：正因为从未部署，生产库目前**没有任何支付表**，此前审计发现的 HIGH/LOW 问题在生产尚未爆发。本次是首次上线，按本方案跑完整迁移序列即可拿到正确版本。

---

## 1. 本次上线内容清单

**前端**（commit `25b50c2`）：个人主页去图标；技能详情页标签/版本折叠。

**后端支付系统**（全部随 main 上线）：
- `0010` 支付/分成地基：17 张表（orders / order_items / payments / refunds / entitlements / memberships / creator_balances / balance_transactions / withdrawals / platform_settings / skill_pricing / wechat_notify_logs 等）+ 架构漂移修复（`users.role` 补列、`skill_status` 补 `pending`）。
- `0011` 创作者会员制：`creator_membership_plans` / `creator_subscriptions` + 老全平台会员过渡续期。
- `0012` 清理废弃表（membership_downloads / settlements / service_orders / skill_manifests / api_calls）。
- `0013` `users.last_seen_at` + 索引（管理端活跃统计）。
- `0014` 余额流水幂等索引（初版，缺 `user_id`）。
- `0015` 余额流水幂等索引（加 `user_id`，修正版）。
- `0016` 删除 `0014` 留下的过严遗留索引 `uq_balance_tx_ref`。
- `0017` 将 `balance_transactions.ref_id` 由 `UUID` 改为 `TEXT`（修复 HIGH：销售入账类型错误）。
- 代码层修复（随上述 commits 进 main，无需单独部署）：付费墙 fail-closed、退款并发原子化、freeze 原子递减、提现防双扣 + 异步终态闭环、余额双入账兜底、会员续订唯一约束、ref_id 实体改 `text` 等。

> **关于"补丁链"的说明**：`0014`→`0015`→`0016` 三步都在调整同一个余额流水幂等索引，最终只剩正确的
> `idx_balance_tx_idempotent(user_id, ref_id, biz_type, direction)`；`0017` 把 `ref_id` 转 `TEXT`。三步全部幂等、可重复执行，在任意数据库状态下都安全。**不要跳过其中任何一步。**

---

## 2. 部署步骤（按顺序照做）

### 2.1 拉取最新代码
```bash
cd /www/wwwroot/agent-skill-platform
git pull
```

### 2.2 执行迁移（按序 0010 → 0017）
```bash
DBUSER=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_USER')
DBNAME=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_DB')

for f in 0010 0011 0012 0013 0014 0015 0016 0017; do
  echo ">> running migration $f"
  docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/${f}_*.sql
done
```
> 每条迁移都带 `IF NOT EXISTS` / `DO $$` 幂等保护，可安全重复跑。

### 2.3 校验迁移结果（关键门禁，必须看输出）
```bash
# ① ref_id 类型必须是 text（否则 HIGH 必现）
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c \
"SELECT data_type FROM information_schema.columns WHERE table_name='balance_transactions' AND column_name='ref_id';"
# 期望：text。若为 uuid → 0017 未成功，先排查再继续。

# ② 余额流水索引只剩正确的那一个（无 uq_balance_tx_ref）
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c \
"SELECT indexname FROM pg_indexes WHERE tablename='balance_transactions';"
# 期望仅含：idx_balance_tx_user、idx_balance_tx_idempotent
```

### 2.4 部署代码（重建 api + web 镜像并启动）
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
> ⚠️ 实体改动（ref_id 类型）需重新编译 api，必须带 `--build`，**不能只 `force-recreate`**。

### 2.5 启动后冒烟
```bash
docker logs --tail 50 agent_platform_api
# 确认无启动报错；再访问站点技能详情页，确认付费墙 / 定价展示正常
```

---

## 3. 回滚

- 本次为支付**首次**上线，生产无支付数据 → 风险低。
- 若上线后异常：回退镜像即可（用上一个 commit 打出的 api 镜像重新启动；数据库迁移均为新增/幂等，无需回退）。
- 仅当确认**无任何支付数据**且需彻底回退时，才可手工 `DROP` 相关支付表（不建议常规操作）。

---

## 4. 上线后建议（非阻塞）

1. 在 staging 用微信桩实跑 `scripts/load-test-payments.mjs`（资金不变量并发压测）作为回归门禁。
2. 接入 `AdminPaymentsService.reconcile()` 定时三向对账 + 告警（diff≠0 即报警）。
3. 压测/高并发时监控 PG 连接池（`pg_stat_activity`），当前 `extra.max=30` 已达标。

---

## 5. 可选清理（确认后再做）

因为 `0010`–`0015` **尚未在任何环境执行**，理论上可把修复直接折进 `0010`（`ref_id` 建表即 `TEXT`、初始就建正确索引），并删除 `0014`–`0017` 冗余迁移，使历史更干净。

但当前 `0010`–`0017` 链路在**任意数据库状态**下都安全幂等，推荐**保持不动**，除非你明确要精简迁移历史。如需精简，告诉我，我会在确认无环境跑过 `0010` 后再做。
