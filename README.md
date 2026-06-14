# Agent Skill Platform

AI Agent 技能分享平台 —— 发现、分享和下载 AI Agent 技能的市场。

[访问网站](https://skills.rehomi.com)

## 简介

Agent Skill Platform 是一个开放的 AI Agent 技能市场，开发者可以在这里：

- 📦 **上传技能** — 打包 ZIP 文件，附带 SKILL.md 元数据
- 🔍 **发现技能** — 按周热门、总榜或最新排序浏览
- ⬇️ **下载使用** — 一键下载技能包，快速集成到工作流
- 👤 **个人主页** — 展示你的技能作品，积累影响力
- 🏆 **排行榜** — 个人榜/团队榜，周榜/总榜实时排名
- 💬 **评论互动** — 为技能打分、留言反馈

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 14 + TypeScript + Tailwind CSS |
| 后端 | NestJS + TypeORM |
| 数据库 | PostgreSQL 18 (Docker 自建) |
| 存储 | 阿里云 OSS |
| 部署 | Docker + Docker Compose (一键三容器) |
| 认证 | JWT + 微信登录 + 邮箱验证码 |

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

## 技能包格式

技能包是一个 ZIP 文件，根目录必须包含 `SKILL.md`：

```yaml
---
name: my-skill
version: 1.0.0
description: 技能描述
tags: [search, web]
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
