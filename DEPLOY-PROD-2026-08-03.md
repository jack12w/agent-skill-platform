# 生产环境完整部署教程（2026-08-03 版）

> 适用范围：将 2026-08-02 ~ 2026-08-03 的全部更新部署到生产环境（skills.rehomi.com）。
> 本次部署包含：微信支付系统、创作者会员制、支付安全审计修复、定价防呆、
> 管理后台修复（折线图/底部通栏/回调日志）、用户活跃统计。
> 对应代码版本：main 分支 `51512da`（含）及之前共 20+ 个提交。

---

## 目录

- [一、本次部署内容总览](#一本次部署内容总览)
- [二、部署前准备](#二部署前准备)
- [三、拉取最新代码](#三拉取最新代码)
- [四、数据库迁移（顺序不能错）](#四数据库迁移顺序不能错)
- [五、配置 .env.production（全量变量）](#五配置-envproduction全量变量)
- [六、微信商户后台配置](#六微信商户后台配置)
- [七、构建并启动容器](#七构建并启动容器)
- [八、部署后验证清单](#八部署后验证清单)
- [九、回滚方案](#九回滚方案)
- [十、常见问题 FAQ](#十常见问题-faq)

---

## 一、本次部署内容总览

| 模块 | 内容 | 涉及迁移 |
|------|------|----------|
| 微信支付系统 | 下单/回调/退款/对账/提现全链路（APIv3） | 0010 |
| 创作者会员制 | 创作者自定价三档会员，订阅费直入创作者余额 | 0011 |
| 废弃表清理 | 从 0010 移除 5 张收益池时代的废弃表（0012 仅清理已跑旧版 0010 的环境） | 0012（可选） |
| 支付安全修复 | 验签 fail-closed、原子防双花、0 元拦截、退款闭环 | — |
| 定价防呆 | member_only/both 模式必须先设会员套餐 | — |
| 管理后台修复 | 折线图竞态、底部渐变通栏、回调日志查询 Tab | — |
| 用户活跃统计 | last_seen_at 追踪 + 7/30/90/180/365 天活跃数 | 0013 |

---

## 二、部署前准备

### 2.1 确认 Docker 镜像加速可用（必做，否则构建超时）

```bash
docker info | grep -A 5 "Registry Mirrors"
```

应看到加速器地址（daocloud/163/baidu 等）。如果没有：
1. 在宝塔面板 Docker 设置中添加加速 URL 后，**必须点"重载/刷新"并重启 Docker 守护进程**才会生效；
2. 或手动编辑 `/etc/docker/daemon.json` 后 `systemctl restart docker`。
3. ⚠️ `docker system prune -f` 会清掉本地基础镜像缓存，下次构建需重新联网拉取——清缓存前务必确认镜像源可用。

### 2.2 确认磁盘空间

```bash
df -h /www
```

建议可用空间 ≥ 10G（node 镜像 + 构建缓存较大）。

### 2.3 准备微信支付凭证（可后置）

支付功能需要 6 个凭证，全部在**微信支付商户平台**（pay.weixin.qq.com）获取：

| 凭证 | 获取位置 |
|------|----------|
| 商户号 MCH_ID | 账户中心 → 商户信息 |
| APIv3 密钥 | 账户中心 → API安全 → APIv3密钥（首次需手动设置） |
| 商户 API 证书（含私钥 apiclient_key.pem、序列号） | 账户中心 → API安全 → 申请 API 证书（用证书工具导出） |
| 平台证书 platform_cert.pem | ⚠️ 网页不提供下载，需用官方 CertificateDownloader 工具或调 `/v3/certificates` 接口拉取 |

前置条件：
- 商户平台「产品中心」已开通 **Native 支付**（扫码支付）
- 公众号 appid（wxb2537...）已在商户平台「AppID账号管理」绑定到该商户号

> **凭证不齐也可以先部署**：支付凭证是懒加载，未配置不影响启动和其他功能，仅下单时提示"微信支付未配置"。凭证补齐后执行「步骤 7.3」单独重建 api 即可。

---

## 三、拉取最新代码

```bash
cd /www/wwwroot/agent-skill-platform
git pull origin main
git log --oneline -3
```

预期最新提交：

```
51512da fix(users): last_seen_at 加 select:false 降级保护 + 用户表格横向滚动
2c51c5f feat(hub): 用户管理页新增活跃统计与注册/最近访问两列
ff72dc1 fix(hub): 数据总览折线图偶发不渲染 + 底部滚动弹出渐变通栏
```

如果版本落后，检查是否有本地未提交改动阻塞 pull（`git status`），生产服务器不应有本地改动。

---

## 四、数据库迁移（顺序不能错）

> **背景**：`synchronize=false`，部署命令**不会**自动跑迁移，必须手动执行。
> **顺序**：0010 → 0011 → 0013（0012 仅旧环境需要，见 4.4）。
> **硬依赖**：0011 和 0013 未执行就重建容器，会导致接口报错（详见各节）。

### 4.1 获取正确的数据库用户名和库名

⚠️ 生产库角色名是 `.env.production` 里的 `DB_USER`，**不是 `postgres`**！
`docker exec -u postgres ...` 会报 `role "postgres" does not exist`。

```bash
DBUSER=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_USER')
DBNAME=$(docker exec agent_platform_db sh -c 'echo $POSTGRES_DB')
echo "用户: $DBUSER  库: $DBNAME"   # 确认非空
```

### 4.2 迁移 0010 — 支付系统建表（12 张表 + 种子）

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0010_payment_system.sql
```

建 orders/payments/refunds/balances/withdrawals/entitlements 等 12 张表，并写入平台设置种子（抽成 10%、冻结 7 天、最低提现 ¥20、会员价 ¥29/79/268）。代码有降级保护，未跑时支付功能不可用但不影响其他功能。

> 0010 已精简：收益池时代的 5 张废弃表已从本迁移移除，全新部署不会再建出它们。

### 4.3 迁移 0011 — 创作者会员制（⚠️ 硬依赖）

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0011_creator_membership.sql
```

建 `creator_membership_plans` + `creator_subscriptions` 两表，并给老全平台 `memberships` 有效记录免费续 1 个月过渡（生产为空表，影响 0 行）。

> ⚠️ **硬依赖**：权益校验的 `isSubscribed` 无降级，未跑 0011 时技能详情页/下载等接口直接 SQL 报错。必须在 0010 之后、重建容器之前执行。

### 4.4 迁移 0012 — 清理废弃表（⚠️ 仅旧环境需要，全新部署可跳过）

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0012_drop_redundant_tables.sql
```

删除收益池时代的 5 张废弃表（membership_downloads/settlements/service_orders/skill_manifests/api_calls）。

> **全新部署（从未跑过旧版 0010）可跳过本步**：0010 已精简，不会再建这些表。
> 本迁移仅用于清理"曾跑过 2026-08-03 之前旧版 0010"的环境。全部 `DROP TABLE IF EXISTS`，
> 幂等，即使跳过不跑、或在不存在的库上跑了，都不会报错。

### 4.5 迁移 0013 — 用户活跃追踪（⚠️ 建议与容器重建同期）

```bash
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0013_user_last_seen.sql
```

users 表加 `last_seen_at` 列 + 索引，支撑管理端"最近访问"列和 5 档活跃数统计。

> 已有降级保护：该列在实体上是 `select:false`，未跑 0013 时登录/注册等业务接口**不受影响**，仅管理端用户列表页报错。但仍建议与其他迁移一并执行。

### 4.6 验证迁移结果

```bash
# 应列出全部 14 张支付/会员相关表（0010 的 12 张 + 0011 的 2 张）
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c "\dt" | grep -E "skill_pricing|orders|payments|refunds|balances|withdrawals|creator_membership|creator_subscriptions|entitlements|platform_settings"

# 应返回 4 行种子（抽成 1000 / 冻结 7 / 最低提现 2000 / 会员价 2900,7900,26800）
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c "SELECT key, value FROM platform_settings;"

# 应返回 last_seen_at 列定义
docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" -c "\d users" | grep last_seen_at
```

---

## 五、配置 .env.production（全量变量）

`.env.production` 手动维护在服务器上（git 不追踪）。完整变量清单如下，
**带 ⚠️ 的是本次新增/必须检查的**，其余为既有变量（确认存在即可）：

```bash
# ── 数据库 ──
DB_HOST=db
DB_PORT=5432
DB_USER=<你的数据库用户>
DB_PASSWORD=<你的数据库密码>
DB_NAME=platform
DB_SSL=false

# ── JWT ──
JWT_SECRET=<强随机串，未设置会导致 API 启动失败>

# ── 域名（⚠️ 支付回调拼接受此影响，必须是 https 完整域名）──
PUBLIC_BASE_URL=https://skills.rehomi.com

# ── 邮件（验证码/通知）──
SMTP_HOST=<SMTP 服务器>
SMTP_PORT=587
SMTP_USER=<邮箱账号>
SMTP_PASS=<邮箱授权码>

# ── 阿里云 OSS（技能文件存储）──
OSS_REGION=<如 oss-cn-hangzhou>
OSS_BUCKET=<bucket 名>
OSS_ACCESS_KEY_ID=<AK>
OSS_ACCESS_KEY_SECRET=<SK>
OSS_PUBLIC_HOST=<OSS 公开访问域名>

# ── Redis ──
REDIS_URL=redis://redis:6379

# ── 管理员 ──
ADMIN_USER_IDS=<管理员用户 id，逗号分隔>

# ── 微信扫码登录（网站应用）──
WECHAT_APPID=wx4e9bbbe62b30fdc8          # 开放平台「网站应用」appid
WECHAT_APPSECRET=<网站应用 secret>
WECHAT_LOGIN_ENABLED=true
WECHAT_REDIRECT_URI=https://skills.rehomi.com/api/auth/wechat/callback

# ── 微信公众号（JS-SDK 分享，与网站应用是两套凭证）──
WECHAT_OA_APPID=wxb2537aa7600236a7
WECHAT_OA_APPSECRET=<公众号 secret>

# ── ⚠️ 微信支付 APIv3（本次新增，6 个）──
WECHAT_PAY_MCH_ID=<商户号>
WECHAT_PAY_APPID=wxb2537aa7600236a7     # 支付用 appid（公众号，不是网站应用 wx4e9b...）
WECHAT_PAY_SERIAL_NO=<商户证书序列号>
WECHAT_PAY_APIV3_KEY=<32 字节 APIv3 密钥>
# PEM 填法：整段用双引号包裹，换行用 \n 转义（代码 resolvePem 自动还原）
WECHAT_PAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
WECHAT_PAY_PLATFORM_CERT="-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----"
```

要点：
- **PEM 证书推荐单行 + `\n` 转义写法**（上面示例），避免 .env 多行解析问题；也支持直接粘含真实换行的完整 PEM 文本（必须含 `-----BEGIN`）。
- 支付凭证不齐可留空先部署，支付功能自动降级为"未配置"提示，不影响其他功能。

---

## 六、微信商户后台配置

登录 pay.weixin.qq.com，完成两项配置：

1. **支付回调地址**（产品中心 → Native 支付 → 开发配置）：
   ```
   https://skills.rehomi.com/api/pay/wechat/notify
   ```
2. **退款回调地址**（退款配置）：
   ```
   https://skills.rehomi.com/api/pay/wechat/refund-notify
   ```

确认：Native 支付产品已签约开通；公众号 appid 已在「AppID账号管理」绑定。

> 回调链路：微信 → 宝塔 Nginx → web:3000（Next.js rewrites `/api/*`）→ api:3001。
> POST body 与验签 headers 默认透传，Nginx 无需额外配置。

---

## 七、构建并启动容器

### 7.1 全量部署（本次用这个）

```bash
cd /www/wwwroot/agent-skill-platform
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

> ⚠️ **必须带 `--env-file .env.production`**：compose 默认只自动加载 `.env`，
> 不读 `.env.production`。漏了会导致 SMTP_USER/PASS、WECHAT_* 等密钥不进容器
> （邮件静默失败、支付未配置）。这是历史踩过的坑。

### 7.2 构建超时处理

1. 确认镜像加速已生效（步骤 2.1）
2. 直接重试（layer 缓存会续传）：
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   ```

### 7.3 仅改了 .env.production（未改代码）时

容器 env 在 create 时注入，`docker restart` **不会**重读 env_file。必须强制重建：

```bash
# 例：补齐微信支付凭证后，只需重建 api（无需 --build，无需 git pull）
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --force-recreate api
```

注意：前端 `NEXT_PUBLIC_*` 变量是**构建期**注入的，改这些才需要 `--build web`；
运行时变量（WECHAT_*/SMTP_* 等）只需 `--force-recreate`。

### 7.4 确认容器状态

```bash
docker compose -f docker-compose.prod.yml ps
```

api / web / db / redis 全部 `Up`（db 应显示 healthy）。

---

## 八、部署后验证清单

### 8.1 基础功能（既有功能回归）

| 检查项 | 方法 | 预期 |
|--------|------|------|
| 首页 | 打开 https://skills.rehomi.com | 正常加载，技能列表有数据 |
| 技能广场/搜索/标签/榜单 | 各点一遍 | 数据正常（0011 相关 SQL 无报错） |
| 登录 | 邮箱验证码 + 微信扫码各试一次 | 均能登录；扫码后**手机上要点"确认登录"** |
| 技能详情页 | 打开任意技能 | 正常显示，无 500 |
| 下载免费技能 | 点击下载 | 正常 |

### 8.2 API 健康检查

```bash
curl -s https://skills.rehomi.com/api/health
# 应返回 {"status":"ok",...}
```

### 8.3 支付系统接口

```bash
TOKEN=<管理员账号登录后的 JWT>

# 1. 平台设置（应返回 commissionRateBp=1000 等种子值）
curl -s https://skills.rehomi.com/api/pay/settings | head -c 300

# 2. 创作者会员套餐公开接口（应返回 hasPlan + suggested: {2900,7900,26800}）
curl -s "https://skills.rehomi.com/api/pay/creator-plan?targetType=user&targetId=<任意创作者id>"

# 3. 对账接口（关键！应返回 balanced: true，无交易时差异为 0）
curl -s -H "Authorization: Bearer $TOKEN" https://skills.rehomi.com/api/admin/pay/reconciliation
```

### 8.4 管理后台（/hub）

| 页面 | 验证点 |
|------|--------|
| 数据总览 | **两个折线图都渲染**（刷新 2~3 次确认每次都出来）；滚到底继续用力滚，**底部不弹渐变通栏** |
| 订单管理 | 列表正常；已支付订单显示「退款」按钮；「微信回调日志」Tab 可打开 |
| 用户管理 | 搜索框右侧显示 5 档活跃数 chips；表格有「注册日期」「最近访问」两列 |
| 交易设置 | 平台抽成/会员价/最低提现显示种子值（10% / 29,79,268 / ¥20） |
| 对账 | 三组金额比对均 balanced |

### 8.5 创作者流程

1. 创作者进入「交易设置」→ 设置会员套餐价格（或沿用推荐价 29/79/268）→ 保存成功
2. 技能编辑页 → 定价模式选「会员专属」：已设套餐时可选；**未设套餐时应看到禁用+提示**（防呆生效）
3. 技能编辑页选「付费下载」：价格低于 1 元应被拒绝（MIN_SELL_CENTS 生效）

### 8.6 端到端支付测试（最重要，建议小额真实测试）

1. 创作者把一个技能设为付费 ¥1（或会员价最低档）
2. 另一个账号下单 → 微信扫码支付 → 观察：
   - 订单状态变为「已完成」
   - 技能可下载（权益开通）
   - 创作者余额增加（金额 − 10% 抽成）
   - hub/orders「微信回调日志」Tab 出现一条 `TRANSACTION.SUCCESS` 记录且处理状态正常
3. 管理员在 hub/orders 对该订单点「退款」→ 全额退款 → 观察：
   - 退款回调日志出现 `REFUND.SUCCESS`
   - 创作者余额等额回冲
   - 订单状态变为「已退款」，下载权限被撤销
   - 对账接口仍 `balanced: true`

---

## 九、回滚方案

### 9.1 代码回滚

```bash
cd /www/wwwroot/agent-skill-platform
git log --oneline -10                     # 找到部署前的 commit
git reset --hard <部署前commit>
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

### 9.2 迁移回滚（谨慎）

- 0010/0011/0013 是**加表/加列**，不破坏已有数据。旧代码不引用这些表/列，**只回滚代码、保留新表是安全的**（推荐）。
- 0012 删除的 5 张表不可恢复（DROP），但它们本就废弃且代码零引用；且新版 0010 已不再创建它们，仅旧环境需要此迁移。
- 如确需删表回滚，手动 DROP 对应表即可（无外部依赖）。

---

## 十、常见问题 FAQ

**Q1：部署后邮件发不出去？**
A：几乎都是漏了 `--env-file .env.production`，SMTP 密钥没进容器。用步骤 7.1 的完整命令重建。

**Q2：改了 .env.production 的变量，重启后没生效？**
A：`docker restart` 不重读 env_file。必须 `up -d --force-recreate api`（步骤 7.3）。

**Q3：构建时拉镜像超时？**
A：镜像加速未生效。宝塔面板加加速 URL 后**必须重载配置并重启 Docker 守护进程**；`docker info | grep Mirrors` 验证。

**Q4：迁移报 `role "postgres" does not exist`？**
A：生产库角色名是 `.env.production` 的 `DB_USER`，不是 `postgres`。用步骤 4.1 的命令自动获取真实用户名。

**Q5：支付下单提示"微信支付未配置"？**
A：6 个 `WECHAT_PAY_*` 变量未配齐。这是懒加载降级，不影响其他功能；配齐后 `--force-recreate api`。

**Q6：支付回调报验签失败 / 回调被拒绝？**
A：检查 `WECHAT_PAY_PLATFORM_CERT` 是否配置正确（验签已改为 fail-closed，未配置一律拒绝）。平台证书需要用官方下载工具获取，商户平台网页没有直接下载入口。到 hub/orders「微信回调日志」Tab 查看具体回调内容排障。

**Q7：微信扫码后网页不跳转？**
A：① 确认手机上点了"确认登录"按钮；② 扫码过程中不要切换网络/VPN（轮询会断），刷新页面重扫。这是微信官方页面的机制，非系统 bug。

**Q8：管理后台用户列表报错，其他页面正常？**
A：迁移 0013 未执行。补跑：`docker exec -i agent_platform_db psql -U "$DBUSER" -d "$DBNAME" < migrations/0013_user_last_seen.sql`。

**Q9：会员套餐/订阅相关接口报 SQL 错？**
A：迁移 0011 未执行（硬依赖）。先跑 0010 再跑 0011。

**Q10：活跃统计显示全是 0？**
A：正常。`last_seen_at` 从部署后开始累积，用户下次登录使用时自动记录；老用户基数为 NULL 显示"从未"。

**Q11：微信轮换平台证书后回调验签全部失败？**
A：微信支付会定期轮换平台证书（通常提前邮件/站内信通知，约一年一次）。当前实现用 `WECHAT_PAY_PLATFORM_CERT` 单个证书验签（fail-closed），微信换证后旧证书验签必失败 → 回调全拒 → 支付入账中断。**处理**：重新下载新平台证书（CertificateDownloader 工具或 `/v3/certificates` 接口），更新 `.env.production` 的 `WECHAT_PAY_PLATFORM_CERT`，然后 `up -d --force-recreate api` 即可恢复。轮换期间微信支付会自动重试回调（最多 15 次/3 天），恢复后历史回调会补发，不会丢账。
