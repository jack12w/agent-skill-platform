# 支付系统生产部署方案（首次上线 runbook）

> 生成/更新：2026-08-05｜适用：当前 main 分支（迁移已精简为 `0010`→`0013`）
> 用途：把近 3 天全部支付相关改动 + 前端优化，**首次**一次性部署到生产。
> 本文档是部署的**唯一权威来源**。

---

## 0. 部署前必读（关键事实）

| 项 | 状态 |
|---|---|
| 近 3 天支付改动（约 40 commits） | ✅ 已全部 `commit` + `push` 到 `main` |
| 生产是否已部署过任何支付代码/表 | ❌ **从未部署**（支付表尚不存在） |
| Git 工作区 | ✅ 干净 |
| 部署命令是否自动跑迁移 | ❌ 不会（`synchronize:false`，无 `migrationsRun`）→ **迁移必须手动 psql 执行** |
| 容器名 | db=`agent_platform_db`，api=`agent_platform_api` |
| DB 连接池 | `extra.max=30`（另有 `poolSize=20`，生效 30）已 ≥20，无需调 |

⚠️ **铁律：部署（`up -d --build`）≠ 建表。两步独立，缺一不可。只部署不跑迁移 → 支付表不存在 → 支付全挂。**

**关于迁移已精简**：原 `0014`/`0015`/`0016`/`0017` 四个"修补迁移"已折入 `0010`（全新部署即 `ref_id` 为 `TEXT`、索引一步到位），因为它们只在"库已跑过错误的 0010"时才有意义；而生产从未部署，任何库都没到过那个错误中间态。所以现在**只需跑 `0010`→`0013`**。

---

## 1. 上线内容清单

**前端**（commit `25b50c2`）：个人主页去图标；技能详情页标签/版本折叠。

**迁移（按序执行）**：
- `0010` 支付/分成地基：建支付表（`balance_transactions.ref_id` 直接为 **TEXT**、余额流水幂等索引 `idx_balance_tx_idempotent(user_id, ref_id, biz_type, direction)` 一步到位）+ 架构漂移修复（`users.role` 补列、`skill_status` 补 `pending`）。
- `0011` 创作者会员制：`creator_membership_plans` / `creator_subscriptions` + 老全平台会员过渡续期。
- `0012` 清理废弃表（membership_downloads / settlements / service_orders / skill_manifests / api_calls）。
- `0013` `users.last_seen_at` + 索引（管理端活跃统计）。

**代码层修复**（随 main 上线，无需单独部署）：付费墙 fail-closed、退款并发原子化、freeze 原子递减、提现防双扣 + 异步终态闭环、余额双入账兜底、会员续订唯一约束、ref_id 实体 `text` 等。

---

## 2. 支付模块所需资料获取位置（部署前必须备齐）

微信支付凭证**全部在微信支付商户平台 [pay.weixin.qq.com](https://pay.weixin.qq.com) 获取**。下表每行对应 `.env.production` 里的一个变量：

| 变量名 | 含义 | 商户平台获取位置 |
|---|---|---|
| `WECHAT_PAY_MCH_ID` | 商户号 | 「账户中心 → 商户信息」→ 微信支付商户号 |
| `WECHAT_PAY_APPID` | 支付用 AppID | **公众号 AppID `wxb2537aa7600236a7`**（= 公众号，≠ 网站扫码登录 AppID `wx4e9b…`，二者 openid 不同）。需在商户平台「AppID 账号管理」绑定该公众号 |
| `WECHAT_PAY_SERIAL_NO` | 商户 API 证书序列号 | 「账户中心 → API 安全 → 申请 API 证书」后，证书详情里的序列号 |
| `WECHAT_PAY_APIV3_KEY` | APIv3 密钥（32 字节） | 「账户中心 → API 安全 → APIv3 密钥」设置（回调解密 + 平台证书下载都要它） |
| `WECHAT_PAY_PRIVATE_KEY` | 商户证书私钥（PEM） | 「申请 API 证书」时用证书工具导出的 `apiclient_key.pem` 全文 |
| `WECHAT_PAY_PLATFORM_CERT` | 微信平台证书公钥（PEM） | **网页不提供下载**！用官方 `CertificateDownloader` 工具，或调 `/v3/certificates` 接口（用上面 APIv3 密钥）拉取 `wxp_pub.pem` 全文 |

**其他前置条件**：
- `PUBLIC_BASE_URL`：你的站点域名，如 `https://skills.rehomi.com`（用于拼接回调地址与分享）。
- **Native 支付产品须在商户平台已开通**（路径 A：平台全额收款）。
- **公众号须在商户平台「AppID 账号管理」绑定**，否则支付报 AppID 未关联。
- **回调地址无需配置变量**：代码按 `PUBLIC_BASE_URL` 自动拼接为 `{PUBLIC_BASE_URL}/api/pay/wechat/notify`（支付）、`/refund-notify`（退款）、`/transfer-notify`（商家转账）。确保该域名已备案 + https。

**PEM 填写格式（`.env.production` 里）**：私钥/平台证书可直接粘完整多行 PEM，或转成**单行 `\n` 转义 + 双引号包裹**（代码 `resolvePem` 会自动还原换行）：
```bash
WECHAT_PAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
WECHAT_PAY_PLATFORM_CERT="-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"
```
> ⚠️ 注意：代码实际读取的变量名是 `WECHAT_PAY_MCH_ID` / `WECHAT_PAY_SERIAL_NO` / `WECHAT_PAY_PRIVATE_KEY` / `WECHAT_PAY_PLATFORM_CERT`。仓库里的 `.env.production.example` 旧版曾误写为 `WECHAT_PAY_MCHID` / `WECHAT_PAY_CERT_SERIAL_NO` / `*_PATH` 系列，**以本表为准**，不要照抄示例旧名。

**自检**：未配齐时，api 启动时**不报错**（凭证 getter 懒加载），但首次支付/回调会报 `微信支付未配置：WECHAT_PAY_*` 或 `WECHAT_PAY_PLATFORM_CERT 未配置，拒绝处理微信回调（fail-closed）`。配好后需 `up -d --force-recreate api`（仅刷新 env，无需 `--build`）。

---

## 3. 部署步骤（按顺序照做）

### 3.1 拉取最新代码
```bash
cd /www/wwwroot/agent-skill-platform
git pull
```

### 3.2 确认支付凭证已在 `.env.production`
对照第 2 节，确认以下 6 个变量已填（其他 `WECHAT_*` 变量由 compose 自动转发）：
```
WECHAT_PAY_MCH_ID / WECHAT_PAY_APPID / WECHAT_PAY_SERIAL_NO
WECHAT_PAY_APIV3_KEY / WECHAT_PAY_PRIVATE_KEY / WECHAT_PAY_PLATFORM_CERT
```

### 3.3 执行迁移（按序 0010 → 0013）
```bash
DBUSER=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_USER')
DBNAME=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_DB')

for f in 0010 0011 0012 0013; do
  echo ">> running migration $f"
  docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/${f}_*.sql
done
```
> 每条迁移都带 `IF NOT EXISTS` / `DO $$` 幂等保护，可安全重复跑。

### 3.4 校验迁移结果（关键门禁，必须看输出）
```bash
# ① ref_id 类型必须是 text
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c \
"SELECT data_type FROM information_schema.columns WHERE table_name='balance_transactions' AND column_name='ref_id';"
# 期望：text（0010 已直接建为 TEXT，全新部署必为 text）

# ② 余额流水索引只剩正确的那一个
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c \
"SELECT indexname FROM pg_indexes WHERE tablename='balance_transactions';"
# 期望仅含：idx_balance_tx_user、idx_balance_tx_idempotent（不应有 uq_balance_tx_ref）
```

### 3.5 部署代码（重建 api + web 镜像并启动）
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
> ⚠️ 实体改动（ref_id 类型）随 `0010` 已是 TEXT，但代码仍重新编译更稳，必须带 `--build`，**不能只 `force-recreate`**。

### 3.6 启动后冒烟
```bash
docker logs --tail 50 agent_platform_api
# 确认无启动报错；访问技能详情页确认付费墙/定价展示正常
```

---

## 4. 回滚

- 本次为支付**首次**上线，生产无支付数据 → 风险低。
- 若上线后异常：用上一个 commit 重新构建 api 镜像启动即可；数据库迁移均为新增/幂等，无需回退。
- 仅当确认**无任何支付数据**且需彻底回退时，才可手工 `DROP` 相关支付表（不建议常规操作）。

---

## 5. 上线后建议（非阻塞）

1. 在 staging 用微信桩实跑 `scripts/load-test-payments.mjs`（资金不变量并发压测）作为回归门禁。
2. 接入 `AdminPaymentsService.reconcile()` 定时三向对账 + 告警（diff≠0 即报警）。
3. 压测/高并发时监控 PG 连接池（`pg_stat_activity`），当前 `extra.max=30` 已达标。

---

## 6. 本次相对旧版部署教程的变更

- 迁移链由 `0010`→`0017` **精简为 `0010`→`0013`**（原 `0014`–`0017` 修补已折入 `0010`）。
- 新增第 2 节「支付模块所需资料获取位置」：明确 6 个 `WECHAT_PAY_*` 变量各自在商户平台的获取入口、PEM 填写格式、回调地址自动拼接逻辑。
- 修正 `.env.production.example`：旧版误用 `WECHAT_PAY_MCHID` / `WECHAT_PAY_CERT_SERIAL_NO` / `*_PATH` 系列，已改为代码实际读取的 `WECHAT_PAY_MCH_ID` / `WECHAT_PAY_SERIAL_NO` / `WECHAT_PAY_PRIVATE_KEY` / `WECHAT_PAY_PLATFORM_CERT`。
