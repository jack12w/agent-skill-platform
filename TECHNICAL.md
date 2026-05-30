# Agent Skill Platform — 技术文档

> **写给接手维护的同事**：本文档记录项目的完整架构、技术栈、开发过程中的坑和决策，读完就能上手。

---

## 一、项目概览

**Agent Skill Platform** 是一个 AI Agent 技能分享平台，用户可以上传/下载/评价 AI 技能包（ZIP 格式，内含 SKILL.md）。

| 项目 | 说明 |
|------|------|
| 仓库结构 | pnpm monorepo（3 个子包） |
| 域名 | `skills.rehomi.com` |
| 服务器 | 阿里云 + 宝塔面板 |
| 部署方式 | Docker Compose（API + Web 两个容器） |
| 数据库 | 阿里云 RDS PostgreSQL |
| 文件存储 | 阿里云 OSS |

---

## 二、技术栈

### 后端（packages/api）

| 技术 | 版本 | 用途 |
|------|------|------|
| NestJS | 10.x | 后端框架 |
| TypeORM | 0.3.x | ORM，连接 PostgreSQL |
| PostgreSQL | 15 | 数据库（阿里云 RDS） |
| Passport + JWT | 10.x | 认证（stateless JWT） |
| ali-oss | 6.x | 阿里云 OSS 文件上传 |
| adm-zip | 0.5.x | 解压 ZIP 读取 SKILL.md |
| bcrypt | 5.x | 密码哈希 |
| helmet | 8.x | HTTP 安全头 |
| compression | 1.7.x | gzip 响应压缩 |
| PM2 | 5.x | 生产环境进程管理（cluster mode） |

### 前端（packages/web）

| 技术 | 版本 | 用途 |
|------|------|------|
| Next.js | 14.2 | App Router 前端框架 |
| React | 18.2 | UI 框架 |
| Tailwind CSS | 3.3 | 样式框架 |
| Ant Design | 5.x | UI 组件库（按需使用） |

### 共享（packages/shared）

| 技术 | 说明 |
|------|------|
| TypeScript + Zod | 共享类型定义和 SKILL.md 校验 |

---

## 三、项目结构

```
agent-skill-platform/
├── packages/
│   ├── api/                   # NestJS 后端
│   │   ├── src/
│   │   │   ├── main.ts        # 入口：Helmet + Compression + 限流 + CORS
│   │   │   ├── app.module.ts  # 根模块：TypeORM 连接池配置
│   │   │   ├── auth/          # 认证模块（JWT 签发/验证）
│   │   │   ├── skills/        # 技能 CRUD + 版本管理 + GEO feed
│   │   │   ├── teams/         # 团队管理
│   │   │   ├── leaderboard/   # 排行榜快照
│   │   │   ├── storage/       # OSS 上传/下载
│   │   │   └── common/        # 限流守卫、健康检查
│   │   └── .env               # 数据库 + OSS + JWT 配置
│   │
│   ├── web/                   # Next.js 前端
│   │   ├── src/
│   │   │   ├── middleware.ts  # 双语路由引擎（/en/ 前缀改写）
│   │   │   ├── app/
│   │   │   │   ├── layout.tsx     # 根布局：SEO metadata + JSON-LD + 字体
│   │   │   │   ├── page.tsx       # 首页
│   │   │   │   ├── sitemap.ts     # 动态 sitemap
│   │   │   │   ├── robots.ts      # 动态 robots.txt（区分 AI 爬虫）
│   │   │   │   ├── auth/          # 登录/注册
│   │   │   │   ├── skills/        # 技能市场 + 详情 + 编辑
│   │   │   │   ├── submit/        # 上传技能
│   │   │   │   ├── leaderboard/   # 排行榜
│   │   │   │   └── llms-full.txt/ # AI 爬虫全文内容
│   │   │   ├── hooks/         # useTranslation（双语 hook）
│   │   │   ├── lib/           # structured-data.tsx（JSON-LD Schema）
│   │   │   └── locales/       # zh.ts / en.ts 翻译文件
│   │   └── public/            # favicon, logo, robots.txt, llms.txt
│   │
│   └── shared/                # 共享包
│       └── src/               # 类型定义、SKILL.md 解析器
│
├── Dockerfile.api             # API 容器构建
├── Dockerfile.web             # Web 容器构建
├── docker-compose.prod.yml    # 生产环境编排（web + api）
├── ecosystem.config.js        # PM2 集群配置
├── .env.production            # 生产环境变量模板
└── schema.sql                 # 数据库建表语句
```

---

## 四、核心架构设计

### 4.1 认证机制

- **JWT stateless**，有效期 7 天
- 支持三种登录方式：**邮箱注册/登录**、**微信扫码登录**
- 邮箱注册需要验证码（10 分钟有效，存入 `verification_codes` 表），通过 nodemailer（QQ 邮箱 SMTP）发送
- 微信 OAuth：`/api/auth/wechat/url` → 微信开放平台 → `/api/auth/wechat/callback`（回调域名在开放平台配置）
- 前端 `localStorage` 存 token
- `AuthGuard` 全局拦截 401
- `AuthProvider` 客户端全局 fetch 拦截，401 自动清除 token 跳登录页

### 4.2 双语路由（/en/）

```
用户访问 /skills/xxx      → middleware 通过 → 中文 UI
用户访问 /en/skills/xxx    → middleware 改写为 /skills/xxx + cookie lang=en → 英文 UI
```

- 同一套页面代码，通过 cookie + `window.__LANG__` 切换语言
- 切换语言时 URL 同步更新（`replaceState`）
- hreflang 标签自动生成（`zh-CN` / `en-US`）

### 4.3 技能版本管理

1. 用户上传 ZIP → 后端解析 SKILL.md（YAML frontmatter）
2. 校验版本号递增（不允许覆盖已有版本）
3. 上传到阿里云 OSS（key: `skills/<uuid>/<version>.zip`）
4. 记录到 `skill_versions` 表

### 4.4 统计与排行榜

| 排序 | 数据源 | 公式 |
|------|--------|------|
| 周热门 | 7 天内 events | `5 + likes_7d × 0.1 + downloads_7d × 0.1` |
| 总排行 | 全部 events | `5 + likes_total × 0.1 + downloads_total × 0.1` |
| 最新 | 创建时间倒序 | — |

### 4.5 SEO / GEO 体系

| 组件 | 路径 | 作用 |
|------|------|------|
| robots.txt | `/robots.txt` | 区分传统/ AI 爬虫策略 |
| Sitemap | `/sitemap.xml` | 动态生成，包含双语 URL |
| JSON-LD | 页面内嵌 | WebSite / Organization / SoftwareApplication / BreadcrumbList |
| OG 标签 | layout metadata | OpenGraph + Twitter Card |
| hreflang | layout metadata | zh-CN ↔ en-US 交替 |
| llms.txt | `/llms.txt` | AI 爬虫指引（ChatGPT/Claude/Perplexity） |
| llms-full.txt | `/llms-full.txt` | 全部 skill 的 Markdown 内容 |
| GEO Feed | `/api/ai/feed` | 结构化 JSON feed（分页 + 统计） |

---

## 五、高并发加固

| 措施 | 位置 | 效果 |
|------|------|------|
| PM2 cluster | `ecosystem.config.js` | 利用所有 CPU 核心 |
| 连接池 30 | `app.module.ts` TypeORM extra.max | 默认 10→30 |
| 全局限流 | `rate-limit.guard.ts` | 每 IP 120次/分钟 |
| gzip 压缩 | `main.ts` compression() | 节省 60-80% 带宽 |
| Helmet | `main.ts` helmet() | 11 个安全头 |
| 30s 超时 | `main.ts` 中间件 | 防止雪崩 |
| 文件大小限制 | `skills.controller.ts` FileInterceptor | 50MB 上限 |

---

## 六、开发过程中踩过的坑

### 6.1 "400 input length too long"

**现象**：上传版本 + 写描述时报错。

**根因**：Express body-parser 默认 JSON 限制 100KB，multer 默认 fieldSize 1MB。

**修复**：`main.ts` 里 `json({ limit: '50mb' })` + FileInterceptor 配置 limits。

### 6.2 登录过期没提示

**根因**：JWT 只 1 天有效，前端没 401 拦截。

**修复**：JWT 改 7 天 + 创建 `AuthProvider` 全局拦截 401 自动跳转。

### 6.3 语言切换只有菜单变

**根因**：`useTranslation` hook 的全局 listeners 机制没生效——toggleLang 改了 globalLang 但没调 `listeners.forEach` 通知其他组件。

**修复**：改成 `setGlobalLang()` 统一通知所有订阅者。

### 6.4 双语路由 Hydration Mismatch

**现象**：访问 `/en/skills/xxx` 时报错 "Text content does not match server-rendered HTML"。

**根因**：SSR 用默认 `'zh'` 渲染，客户端水合时读 cookie 发现是 `'en'`。

**修复**：layout 注入 `<script>window.__LANG__="en"</script>` 在 React 水合前设定语言，`LangInit` 组件同步 SSR 和客户端。

### 6.5 Docker 构建文件找不到

**现象**：COPY 报 `not found`。

**根因**：
1. Dockerfile 引用了不存在的 `turbo.json` / `tsconfig.base.json`
2. 压缩包丢了 `packages/api/src/` 等目录结构
3. npm workspaces 把 node_modules 提升到根目录，COPY 路径写错了

**修复**：
- 去掉 turbo/turbo.json 依赖，直接用 `npx tsc` 构建
- 改为 `Copy-Item -Recurse` 保持完整目录结构
- COPY `/app/node_modules` 而非 `/app/packages/api/node_modules`

### 6.6 Google Fonts 构建超时

**现象**：Docker 构建 Next.js 时 `ETIMEDOUT` 连接 `fonts.googleapis.com`。

**根因**：国内 Docker 容器无法访问 Google Fonts。

**修复**：去掉 `next/font/google` 的 Inter，改用系统字体栈（`-apple-system, Segoe UI, Noto Sans SC`）。

### 6.7 OSS GEO Feed 硬编码 example.com

**现象**：`/api/ai/feed` 返回的 URL 全是 `https://example.com/skills/...`。

**根因**：`skills.service.ts` 里 `getGeoFeed()` 写死了。

**修复**：改为从环境变量 `PUBLIC_BASE_URL` 读取，增加 meta 分页信息。

### 6.8 JSON-LD StructuredData 组件空值崩溃

**现象**：`items.map is not a function`。

**根因**：`BreadcrumbSchema` / `SkillSchema` 参数为 undefined 时没防护。

**修复**：加了 `if (!Array.isArray(items)) return null` 空值守卫。

### 6.9 Docker 网络创建失败：`goto 'PRE_docker' / 'FWDI_docker' is not a chain`

**现象**：`docker compose up` 报错 `failed to create network: iptables-restore: goto 'PRE_docker' is not a chain`，之后变成 `goto 'FWDI_docker' is not a chain`，API 和 Web 容器无法启动。

**根因**：服务器 CentOS 7，自带 **iptables 1.4.21** 版本过老，与新版 Docker 的 iptables 链管理不兼容。同时 **firewalld 服务**在 `PREROUTING` `FORWARD` 链里插入了 `FWDI_` / `PRE_` 等自定义链引用，但这些链在 Docker 重启后没被重建，iptables 1.4.21 解析失败，Docker 无法插入自己的 `DOCKER` / `DOCKER-USER` 链。

**修复**：
1. 停用 firewalld：`systemctl mask firewalld`
2. 清空所有 iptables 规则：`iptables -F -X -t nat -F -t nat -X -t mangle -F -t mangle -X`
3. 重启 Docker：`systemctl restart docker`

> ⚠️ 关 firewalld 后，宝塔面板的防火墙 UI 会显示"未启动"，端口放行需改用 iptables 命令或云服务商安全组。

### 6.10 Docker 容器连不上阿里云 RDS PostgreSQL

**现象**：API 容器启动后反复重试，日志报 `Connection terminated due to connection timeout`，最终崩溃退出。宿主机上 `ss -tlnp | grep 5432` 无输出。

**根因**：API 容器通过 docker bridge 访问 `pgm-*.pgsql.cn-chengdu.rds.aliyuncs.com:5432`，但出口 IP（宿主机内网 IP）**未被添加到阿里云 RDS 白名单**，网络包被 RDS 直接丢弃（timeout，非 refused）。

**修复**：
1. 确认宿主机内网出口 IP：`ip addr | grep eth0` → `172.20.204.134`
2. 登录阿里云 RDS 控制台 → 数据安全性 → 白名单设置 → 添加该内网 IP

> 💡 如果 ECS 和 RDS 在同一 VPC、同地域，推荐使用 RDS **内网地址** + ECS **内网 IP 白名单**（速度快、免费、安全）。

### 6.11 compression 模块导入报错：`compression_1.default is not a function`

**现象**：API 容器启动时抛 `TypeError: (0, compression_1.default) is not a function`。

**根因**：`compression` 是 CommonJS 模块，但 `packages/api/tsconfig.json` 未开启 `esModuleInterop`。虽然 `allowSyntheticDefaultImports` 让 TS 编译通过，但编译产物中 `import compression from 'compression'` 在运行时拿不到 `.default`，实际拿到的是整个 module 对象（一个函数，但无 `.default`）。

**修复**：`packages/api/tsconfig.json` 增加 `"esModuleInterop": true`。

```diff
  "allowSyntheticDefaultImports": true,
+ "esModuleInterop": true,
```

### 6.12 AdmZip 不可构造：`TS2351: This expression is not constructable`

**现象**：开启 `esModuleInterop` 后，`npx tsc` 报 `skills.service.ts:159: error TS2351: This expression is not constructable`。

**根因**：`esModuleInterop` 改变了 CJS 模块的类型推导规则。`import * as AdmZip from 'adm-zip'` 模式下 `new AdmZip()` 在严格模式被判为不可构造；应该用默认导入 `import AdmZip from 'adm-zip'`。

**修复**：`packages/api/src/skills/skills.service.ts` 第 12 行：
```diff
- import * as AdmZip from 'adm-zip';
+ import AdmZip from 'adm-zip';
```

### 6.13 Web 容器启动找不到 `.next` 生产构建

**现象**：Web 容器日志重复报错 `Error: Could not find a production build in the '.next' directory. Try building your app with 'next build' before starting the production server.`，即使镜像构建时 `next build` 成功输出 `.next` 目录。

**根因**：`Dockerfile.web` 最后一行是 `CMD ["npx", "next", "start", "-p", "3000"]`，而 stage-1 的 `WORKDIR` 是 `/app`。`next start` 在 `/app` 下找 `./.next`，但构建产物实际位于 `/app/packages/web/.next`（Dockerfile 的 COPY 路径）。

**修复**：`Dockerfile.web` 在 `EXPOSE 3000` 后、`CMD` 前增加 `WORKDIR /app/packages/web`：

```diff
  EXPOSE 3000

+ WORKDIR /app/packages/web
+
  CMD ["npx", "next", "start", "-p", "3000"]
```

### 6.14 部署常见 root cause 总结

| 层级 | 概率 | 典型问题 |
|------|------|---------|
| iptables/firewalld 冲突 | ⭐⭐⭐ | CentOS 7 + Docker 25+ 天生不兼容，要关 firewalld |
| 阿里云 RDS 白名单 | ⭐⭐⭐ | 换机器、换网络后必查 |
| tsconfig 兼容性 | ⭐⭐ | CJS 模块的 `esModuleInterop` / `import` 写法 |
| Dockerfile WORKDIR | ⭐⭐ | `next start` / `nest start` 的工作目录必须和产物位置一致 |
| 构建缓存 | ⭐ | 老镜像 cache 导致 `.next` 未更新，用 `--no-cache` 清掉 |

### 6.15 注册返回格式不一致导致前端报 "undefined is not valid JSON"

**现象**：注册成功后自动跳转 dashboard，页面白屏报 `SyntaxError: "undefined" is not valid JSON`。

**根因**：`register()` 返回的是裸 User 实体（`return this.userRepository.save(user)`），但前端期望和 `login()` 一致的格式 `{ access_token, user: { id, email, name, avatar_url } }`。前端 `JSON.stringify(data.user)` → `"undefined"` 字面量存入 localStorage → dashboard 页 `JSON.parse("undefined")` 崩溃。

**修复**：`register()` 改为返回 `{ access_token: await this.jwtService.signAsync(payload), user: {...} }`。

### 6.16 NEXT_PUBLIC_BASE_URL 未设置导致 Next.js SSR 崩溃

**现象**：页面报 `Invalid URL`，metadataBase 构造失败。

**根因**：`NEXT_PUBLIC_*` 环境变量在 Next.js 构建时注入。web 包之前没有 `.env` 文件提供默认值，`new URL(undefined)` 直接崩溃。

**修复**：创建 `packages/web/.env`，设 `NEXT_PUBLIC_BASE_URL=http://localhost:3000`（开发默认值）。生产环境由 `docker-compose.prod.yml` 注入。

### 6.17 SMTP 发送失败被静默吞掉

**现象**：前端点击获取验证码显示"已发送"，但邮箱收不到。

**根因**：`sendVerificationCode()` 的 catch 块为空 `catch {}`，nodemailer 发送失败（SMTP 未配置/auth 错误）被完全吞掉。

**修复**：catch 块改为记录 `console.error` + 开发环境（`SMTP_USER` 为空时）直接返回验证码，前端自动填入输入框。生产环境正常发邮件。发件人显示名设为 `"Skill Register"`。

---

## 七、环境变量速查

| 变量 | 说明 | 位置 |
|------|------|------|
| `DB_HOST/PORT/USER/PASSWORD/NAME` | 阿里云 RDS | `packages/api/.env` |
| `JWT_SECRET` | JWT 签名密钥 | `packages/api/.env` |
| `SMTP_HOST/PORT/USER/PASS` | QQ 邮箱 SMTP（发验证码） | `packages/api/.env` |
| `WECHAT_APPID/APPSECRET` | 微信开放平台 | `packages/api/.env` |
| `WECHAT_REDIRECT_URI` | 微信 OAuth 回调（可选，默认 `${PUBLIC_BASE_URL}/api/auth/wechat/callback`） | `packages/api/.env` |
| `OSS_*` | 阿里云 OSS | `packages/api/.env` |
| `PUBLIC_BASE_URL` | 网站域名（不含路径，如 `https://skills.rehomi.com`） | `.env.production` |
| `NEXT_PUBLIC_BASE_URL` | 前端域名 | `packages/web/.env`（本地）/ `.env.production`（生产） |

---

## 八、常用命令

```bash
# Docker 生产部署
# 注：必须指定 --env-file，否则 ${DB_HOST} 等变量为空
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f
docker compose -f docker-compose.prod.yml --env-file .env.production down

# 或将 .env.production 软链为 .env 免除 --env-file
ln -sf .env.production .env
docker compose -f docker-compose.prod.yml up -d --build

# PM2 管理
pm2 start ecosystem.config.js
pm2 reload all
pm2 logs api

# 数据库 stats 刷新
# 调用 StatsAggregationService.aggregateStats()
```

---

## 九、API 端点速查

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 否 | 邮箱登录 |
| POST | `/api/auth/register` | 否 | 邮箱注册（需验证码） |
| POST | `/api/auth/send-code` | 否 | 发送邮箱验证码 |
| GET | `/api/auth/wechat/url` | 否 | 获取微信 OAuth 授权链接 |
| GET | `/api/auth/wechat/callback` | 否 | 微信 OAuth 回调 |
| POST | `/api/auth/wechat/mock-login` | 否 | 🧪 本地开发模拟微信登录 |
| POST | `/api/auth/me/avatar` | 是 | 上传头像到 OSS |
| GET | `/api/skills?sort=weekly\|total` | 否 | 技能列表 |
| GET | `/api/skills/:id` | 否 | 技能详情 |
| POST | `/api/skills/:id/versions` | 是 | 上传新版本 |
| POST | `/api/skills/:id/like` | 是 | 点赞 |
| DELETE | `/api/skills/:id/comments/:commentId` | 是 | 删除自己的评论 |
| GET | `/api/leaderboard` | 否 | 排行榜 |
| GET | `/api/ai/feed` | 否 | GEO feed |
| GET | `/api/health` | 否 | 健康检查 |

---

## 十、部署前置检查清单

部署或迁移服务器时，按以下顺序排查：

- [ ] `systemctl status firewalld` — 如果是 running，`systemctl mask firewalld`（CentOS 7 必做）
- [ ] iptables 规则无残留：`iptables -L -n` / `iptables -t nat -L -n` 无 `FWDI_` / `PRE_` 等非 Docker 链
- [ ] `.env.production` 存在，其中的 `DB_HOST/PORT/USER/PASSWORD/NAME` 正确
- [ ] 宿主机内网 IP 已加入阿里云 RDS 白名单
- [ ] `.env.production` 已软链到 `.env`（可选，免敲 `--env-file`）
- [ ] ECS 安全组放行 3000（web）和 3001（api）端口
- [ ] `docker compose -f docker-compose.prod.yml build --no-cache` 成功
- [ ] `docker compose -f docker-compose.prod.yml up -d` 后 `ps` 显示 Up / healthy
- [ ] `curl -I http://127.0.0.1:3000` 返回 200

---

*最后更新：2026-05-29*
