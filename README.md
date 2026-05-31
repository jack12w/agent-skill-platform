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
| 数据库 | PostgreSQL (阿里云 RDS) |
| 存储 | 阿里云 OSS |
| 部署 | Docker + Docker Compose |
| 认证 | JWT + 微信登录 + 邮箱验证码 |

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/jack12w/agent-skill-platform.git
cd agent-skill-platform

# 安装依赖
npm ci

# 启动本地开发环境
docker compose up -d  # 启动 PostgreSQL
npm run dev           # 启动前后端
```

访问 http://localhost:3000

## 生产部署

```bash
# 1. 准备环境变量
cp .env.production.example .env.production
# 编辑 .env.production，填写数据库、OSS、微信等配置

# 2. 构建并启动
docker compose -f docker-compose.prod.yml up -d --build

# 3. 清理旧镜像（可选）
docker system prune -f
```

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
