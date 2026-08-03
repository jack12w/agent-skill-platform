# 生产环境部署方案

> **适用范围**：本次部署包含 08-02 ~ 08-03 全部改动（17 个 commit + 1 个安全审计修复 commit `eb4827e`），涵盖微信支付系统、创作者会员制、退款闭环、安全审计修复。**生产环境尚未部署任何这些内容。**

---

## 一、部署前准备

### 1.1 确认服务器 Docker 镜像加速可用

```bash
docker info | grep "Registry Mirrors"
```

如果为空，在宝塔面板 → Docker → 镜像加速中添加加速 URL（如 `https://docker.m.daocloud.io`），**添加后必须点「重载配置」并重启 Docker 守护进程**，否则构建拉取 node:20-alpine 会超时。

```bash
# 验证加速生效
docker info | grep "Registry Mirrors"
```

### 1.2 确认服务器磁盘空间

```bash
df -h /www
```

Docker 重建会产生新镜像层，建议至少预留 3GB 可用空间。

---

## 二、拉取最新代码

```bash
cd /www/wwwroot/agent-skill-platform
git pull origin main
```

确认最新 commit 为 `eb4827e`：

```bash
git log --oneline -3
# 预期输出：
# eb4827e fix(payments): 支付安全审计修复 ...
# 7eb45ce feat: 技能详情页订阅作者按钮同步免费/付费分支逻辑
# abea1ef feat: 未设付费套餐时订阅按钮改为免费关注，设了付费才走支付
```

---

## 三、执行数据库迁移（关键！顺序不能错）

> **注意**：`synchronize=false`，部署命令不会自动跑迁移。必须手动执行。
> **顺序**：0010 → 0011 → 0012，不能跳序。

### 3.1 获取正确的数据库用户名和库名

```bash
DBUSER=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_USER')
DBNAME=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_DB')
echo "用户=$DBUSER 库=$DBNAME"
```

> **⚠️ 常见错误**：直接用 `postgres` 用户会报 `role "postgres" does not exist`，因为生产库用户是 `.env.production` 里的 `DB_USER`。

### 3.2 执行迁移 0010 — 支付系统建表

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0010_payment_system.sql
```

**验证**：应看到多行 `CREATE TABLE` / `CREATE INDEX` 输出，无报错。

### 3.3 执行迁移 0011 — 创作者会员制（硬依赖 0010）

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0011_creator_membership.sql
```

> **⚠️ 重要**：0011 无代码降级保护。不跑则会员套餐/订阅/权益校验接口直接报 SQL 错。

### 3.4 执行迁移 0012 — 清理废弃表

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0012_drop_redundant_tables.sql
```

### 3.5 验证表结构

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c "\dt" | grep -E "skill_pricing|orders|order_items|payments|refunds|balances|balance_transactions|withdrawals|creator_membership_plans|creator_subscriptions|entitlements|platform_settings"
```

应看到以上所有表名。再验证种子数据：

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c "SELECT key, value FROM platform_settings;"
```

预期输出：

| key | value |
|-----|-------|
| commission_rate_bp | 1000 |
| settlement_delay_days | 7 |
| withdraw_min_cents | 2000 |
| membership_prices | {"monthly": 2900, "quarterly": 7900, "yearly": 26800} |

---

## 四、配置 .env.production 微信支付变量

编辑服务器上的 `.env.production`（不会被 git 覆盖），添加以下变量：

```bash
nano /www/wwwroot/agent-skill-platform/.env.production
```

**需要新增的变量**（如果已有则确认值正确）：

```env
# ── 微信支付 APIv3 ──
WECHAT_PAY_MCH_ID=你的商户号
WECHAT_PAY_APPID=wxb2537aa7600236a7
WECHAT_PAY_SERIAL_NO=你的商户证书序列号
WECHAT_PAY_APIV3_KEY=你的APIv3密钥（微信商户平台设置的32位密钥）
WECHAT_PAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n你的商户API私钥（多行用\n连接）\n-----END PRIVATE KEY-----
WECHAT_PAY_PLATFORM_CERT=-----BEGIN CERTIFICATE-----\n微信支付平台证书\n-----END CERTIFICATE-----

# ── 回调域名 ──
PUBLIC_BASE_URL=https://skills.rehomi.com
```

> **获取方式**：
> - `WECHAT_PAY_MCH_ID`：微信商户平台 → 账户中心 → 商户信息
> - `WECHAT_PAY_SERIAL_NO`：商户平台 → API安全 → 管理证书 → 证书序列号
> - `WECHAT_PAY_APIV3_KEY`：商户平台 → API安全 → 设置APIv3密钥
> - `WECHAT_PAY_PRIVATE_KEY`：你下载的商户 API 证书私钥文件内容
> - `WECHAT_PAY_PLATFORM_CERT`：微信支付平台证书（非商户证书），通过 API 或工具下载

> **⚠️ 安全**：私钥和 APIv3 密钥是最高敏感信息，切勿泄露或提交到 git。

### 配置微信支付商户后台回调地址

在微信商户平台 → 产品中心 → 开发配置中，设置以下回调 URL：

| 回调类型 | URL |
|---------|-----|
| 支付通知 | `https://skills.rehomi.com/api/pay/wechat/notify` |
| 退款通知 | `https://skills.rehomi.com/api/pay/wechat/refund-notify` |

---

## 五、重建并启动容器

> **关键**：必须带 `--env-file .env.production`，否则 SMTP_USER/PASS/WECHAT_PAY_* 等密钥不进容器。

```bash
cd /www/wwwroot/agent-skill-platform
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

**预计耗时**：5~15 分钟（取决于网络拉取基础镜像速度）。

### 如果构建超时（Docker Hub 拉取慢）

```bash
# 1. 确认镜像加速已配置（见步骤 1.1）
# 2. 重试
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

### 仅改了 .env.production 变量（未改代码）时强制重建

如果只改了 `.env.production` 里的运行时环境变量（如 WECHAT_PAY_*），不需要 `--build`，但必须 `--force-recreate`：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --force-recreate api
```

---

## 六、部署后验证清单

### 6.1 容器状态

```bash
docker compose -f docker-compose.prod.yml ps
```

确认 `api` 和 `web` 状态都是 `Up`。

### 6.2 API 健康检查

```bash
curl -s https://skills.rehomi.com/api/health | head -5
```

### 6.3 支付系统关键接口验证

```bash
# 1. 平台设置（应返回 commissionRateBp=1000 等）
curl -s https://skills.rehomi.com/api/admin/pay/settings \
  -H "Authorization: Bearer <ADMIN_TOKEN>" | python3 -m json.tool

# 2. 某创作者会员套餐（公开接口，应返回 hasPlan + suggested）
curl -s "https://skills.rehomi.com/api/pay/membership/plan?targetType=user&targetId=<SOME_USER_ID>" | python3 -m json.tool

# 3. 对账接口（管理员）
curl -s https://skills.rehomi.com/api/admin/pay/reconcile \
  -H "Authorization: Bearer <ADMIN_TOKEN>" | python3 -m json.tool
# 应返回 balanced: true（无交易时差异为 0）
```

### 6.4 前端页面验证

| 页面 | URL | 检查点 |
|------|-----|--------|
| 技能广场 | https://skills.rehomi.com | 正常加载，无报错 |
| 帮助中心-付费与订阅 | https://skills.rehomi.com/help | 显示创作者会员制说明，推荐价 ¥29/¥79/¥268 |
| 付费服务条款 | https://skills.rehomi.com/agreement | 正常加载 |
| 用户订单页 | https://skills.rehomi.com/account/orders | 正常加载（登录后） |
| 管理后台-订单 | https://skills.rehomi.com/hub/orders | 显示退款按钮 |
| 管理后台-交易设置 | https://skills.rehomi.com/hub/pay-settings | 抽成10%、冻结7天、最低提现¥20 |
| 管理后台-对账 | https://skills.rehomi.com/hub/reconciliation | balanced=true |

### 6.5 微信支付连通性验证

在管理后台 → 交易设置页面，确认抽成比例等设置可正常读取和保存。

> **真实支付测试**：建议先用 ¥0.01 的测试技能或 ¥29 月度会员做一笔真实小额支付，确认：
> 1. 微信扫码弹窗正常出现
> 2. 支付后回调成功（订单状态变为 DELIVERED）
> 3. 创作者余额正确入账（扣除平台抽成后）
> 4. 权益/订阅正确发放

---

## 七、回滚方案

### 7.1 代码回滚

```bash
cd /www/wwwroot/agent-skill-platform
git log --oneline -20  # 找到部署前的 commit
git checkout <部署前的commit> -- .
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

### 7.2 迁移回滚（谨慎）

迁移 0010/0011/0012 是建表 + 种子，不会破坏已有数据。如果必须回滚：

```sql
-- 0012 已删的表不可恢复（DROP），但那些表本就废弃
-- 0011 创建的表可安全删除
DROP TABLE IF EXISTS creator_subscriptions;
DROP TABLE IF EXISTS creator_membership_plans;
-- 0010 创建的表（如需彻底回滚）
DROP TABLE IF EXISTS wechat_notify_logs, refunds, withdrawals, balance_transactions, balances, entitlements, payments, order_items, orders, skill_pricing, platform_settings CASCADE;
```

> **建议**：迁移 0010/0011 建的表即使不回滚代码也不影响已有功能（synchronize=false，旧代码不引用这些表）。所以**只回滚代码、保留新表**是安全的。

---

## 八、已知注意事项

1. **老全平台会员过渡**：迁移 0011 自动给仍有效的老 `memberships` 记录免费续 1 个月。过渡期内老会员仍可下载会员技能，但不再参与收益池分配（收益池已下线）。

2. **创作者定价入口**：当前个人创作者的会员定价设置在管理后台 `/hub/pay-settings` 页面（管理员可见）。普通创作者暂无独立入口，需管理员代设或后续迭代增加创作者端定价页面。

3. **微信支付平台证书续期**：`WECHAT_PAY_PLATFORM_CERT` 会过期，需定期通过微信支付 API 更新。验签已改为 fail-closed，证书过期后回调会全部拒绝 → 支付功能不可用但不会被伪造。

4. **退款需人工审核**：退款由管理员在 `/hub/orders` 手动发起，无自动退款逻辑。全额退款会自动撤销用户权益/订阅并冲正创作者余额。

5. **对账基准**：`/api/admin/pay/reconcile` 做的是金额维度三组对账（收入侧/分成侧/余额侧），返回 `balanced: true` 表示账目平衡。
