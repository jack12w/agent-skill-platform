# SkillDepot — AI Agent Skills Marketplace

> **专为跨境电商卖家与 AI 开发者打造的 Agent 技能市场**  
> 发现、分享和下载 AI Agent 技能，一键集成到你的工作流。

🌐 **[skills.rehomi.com](https://skills.rehomi.com)**

---

## 是什么？

SkillDepot 是一个开放的 AI Agent 技能市场，重点覆盖**跨境电商**场景：

- 🇨🇳 **阿里巴巴国际站（AIDC）** — Listing 优化、生意助手集成、RFQ 自动回复、关键词优化
- 🛒 **亚马逊（Amazon）** — 广告投放优化、Review 管理、选品分析、Listing A+ 内容生成
- 🛍️ **Shopify / 独立站** — 产品描述生成、邮件营销自动化、客服机器人、SEO 优化
- 📝 **WordPress 电商** — WooCommerce 自动化、内容生成、插件推荐技能
- 📊 **通用跨境** — 数据分析、社媒营销、供应链管理、合规风控

### 核心功能

| 功能 | 说明 |
|------|------|
| 📦 **上传技能** | 打包 ZIP，附带 SKILL.md 元数据，一键发布 |
| 🔍 **发现技能** | 按周热门、总榜或最新排序，分类筛选 |
| ⬇️ **下载使用** | 一键下载技能包，即刻集成到 WorkBuddy / 任意 AI 工作流 |
| 👤 **个人主页** | 展示技能作品，积累开发者影响力 |
| 🏆 **排行榜** | 个人榜/团队榜，周榜/总榜实时排名 |
| 💬 **评论互动** | 打分、留言反馈，筛选高质量技能 |

---

## 适合谁？

| 用户类型 | 使用场景 |
|---------|---------|
| 跨境电商卖家 | 下载现成 AI 技能，提升运营效率 |
| AI 开发者 | 发布自研技能，获得社区认可 |
| 运营/市场团队 | 发现适合自己业务的自动化工具 |
| 独立站运营者 | Shopify / WP 场景的 AI 工具包 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 14 + TypeScript + Tailwind CSS |
| 后端 | NestJS + TypeORM |
| 数据库 | PostgreSQL 18 (Docker 自建) |
| 存储 | 阿里云 OSS |
| 部署 | Docker + Docker Compose (一键三容器) |
| 认证 | JWT + 微信登录 + 邮箱验证码 |

---

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/jack12w/agent-skill-platform.git
cd agent-skill-platform

# 安装依赖
npm ci --legacy-peer-deps

# 启动本地 PostgreSQL
docker compose up -d db

# 启动前后端开发服务器
npm run dev
```

访问 http://localhost:3000

> 本地开发使用 `docker-compose.yml`，PostgreSQL 暴露 5432 端口，默认账户 `postgres/postgres`。

## 生产部署

```bash
# 1. 克隆仓库
git clone https://github.com/jack12w/agent-skill-platform.git
cd agent-skill-platform

# 2. 创建 .env.production（参考 .env.production.example）
#    关键配置：JWT_SECRET, OSS_*, SMTP_*, WECHAT_*, DB_*
#    DB_HOST 设为 db（Docker 内部网络自动解析）

# 3. 一键启动（API + Web + PostgreSQL 三容器）
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# 4. 日常更新
git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# 5. 清理构建缓存（可选）
docker builder prune -f
```

> **注意**：生产 Docker Compose 已内置 PostgreSQL 18 容器，不需要外部数据库。数据持久化在 Docker Volume `postgres_data` 中。

### 数据库备份

建议在宝塔面板设置定时任务，脚本如下：

```bash
#!/bin/bash
BACKUP_DIR=/www/backup/pg
mkdir -p $BACKUP_DIR
docker exec agent_platform_db pg_dump -U pguser -d platform -F c > $BACKUP_DIR/platform_$(date +%Y%m%d).dump
find $BACKUP_DIR -name "platform_*.dump" -mtime +30 -delete
```

恢复：`docker exec -i agent_platform_db pg_restore -U pguser -d platform < backup.dump`

---

## 技能包格式

技能包是一个 ZIP 文件，根目录必须包含 `SKILL.md`：

```yaml
---
name: my-skill
version: 1.0.0
description: 技能描述
tags: [阿里国际站, Listing优化, 跨境电商]
---

# 使用说明
这里是技能的详细使用文档...
```

文件限制：300KB 以内

## 评分规则

**单技能**：基础分 5 分 + 点赞 × 0.3 + 下载 × 0.3

**排行榜**（按人/团队聚合）：技能贡献使用对数衰减 `log₂(技能数+1) × 5`，防止大量低互动技能刷榜。点赞和下载权重各 × 0.3。

## 项目结构

```
agent-skill-platform/
├── packages/
│   ├── web/          # Next.js 前端
│   ├── api/          # NestJS 后端
│   └── shared/       # 共享类型和工具
├── docker-compose.yml           # 本地开发
├── docker-compose.prod.yml      # 生产部署
└── README.md
```

---

## GitHub Topics（建议添加）

在仓库设置中添加以下 topics 标签，提升 GitHub 搜索收录：

`ai-agent` · `skills-marketplace` · `cross-border-ecommerce` · `alibaba-international` · `amazon-seller` · `shopify-automation` · `nextjs` · `nestjs` · `workflow-automation` · `ai-tools` · `ecommerce-ai` · `open-source`

---

## License

MIT
