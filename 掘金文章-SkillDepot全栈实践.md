# 开源了一个 AI Agent 技能市场 — 专为跨境电商场景打造（Next.js + NestJS 全栈实践）

> **项目**：[SkillDepot 技能广场](https://skills.rehomi.com)  
> **代码**：[github.com/jack12w/agent-skill-platform](https://github.com/jack12w/agent-skill-platform)  
> **关键词**：Next.js 14、NestJS、PostgreSQL、TypeScript、全栈

---

## 前言

去年开始，身边做跨境电商的朋友都在问同一个问题：

> "AI 工具这么多，到底哪个真的能帮我提效？"

不是没有 AI 工具，而是**技能和经验是分散的**——张三写了一个很溜的 Listing 优化 Prompt，离职了就带走了；李四研究出了阿里国际站的 RFQ 自动回复模板，只在自己电脑里用。

如果能有一个平台，让大家把**已经验证有效的 AI 技能打包上传**，需要的人直接下载就能用，会不会解决这个问题？

于是做了 **SkillDepot**——一个开源的 AI Agent 技能市场。

这篇文章不讲营销，只讲技术实现。如果你也在做类似的技能市场、模板市场、插件市场，或者对 Next.js + NestJS 全栈架构感兴趣，应该会有收获。

---

## 一、项目概览

### 核心功能

| 功能 | 说明 |
|------|------|
| 技能上传 | 上传 ZIP 包（内含 `SKILL.md` 元数据），支持批量 |
| 技能浏览 | 搜索、分类、按标签筛选 |
| 技能下载 | 一键下载 ZIP，直接导入 WorkBuddy 或其他 AI 工作流 |
| 排行榜 | 周榜/总榜，点赞+下载综合得分，防刷分算法 |
| 评论系统 | 打分+评论，社区质量筛选 |
| 用户系统 | 邮箱注册 + JWT + 微信登录 |
| 多语言 | 中英双语，自动切换 |

### 覆盖的跨境电商场景

- **阿里巴巴国际站**：Listing 优化、RFQ 自动回复、关键词分析
- **Amazon**：广告优化、Review 管理、选品分析
- **Shopify / 独立站**：产品描述生成、SEO 优化
- **WordPress 电商**：WooCommerce 自动化
- **通用**：社媒营销、客服机器人、供应链管理

---

## 二、技术架构

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    CDN / 域名解析                           │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                 Next.js 14 Web (Port 3000)                   │
│   App Router · React Server Components · Server Actions      │
│   Tailwind CSS · Server-side sitemap/robots                  │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTP API
┌─────────────────────────────▼───────────────────────────────┐
│                   NestJS API (Port 3001)                     │
│   Controllers · Services · Guards · Interceptors             │
│   TypeORM · Zod Validation · Rate Limiting                   │
│   JWT Auth · OSS Upload · Leaderboard Engine                 │
└────────┬────────────────────┬──────────────────┬────────────┘
         │                    │                  │
         ▼                    ▼                  ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────┐
│ PostgreSQL 18│   │  阿里云 OSS      │   │  SMTP    │
│  (主数据库)  │   │ (技能 ZIP 存储)   │   │ (邮件)   │
└──────────────┘   └──────────────────┘   └──────────┘
```

### 技术栈选型

| 层 | 技术 | 选型理由 |
|----|------|---------|
| 前端 | Next.js 14 App Router | SSR 天然对 SEO 友好，App Router 布局嵌套灵活 |
| 样式 | Tailwind CSS + 自定义 CSS 变量 | 快速开发，主题统一 |
| 后端 | NestJS + TypeORM | 模块化好，和 Next.js 共享 TypeScript 类型 |
| 数据库 | PostgreSQL 18 | JSONB 支持元数据存储，适合灵活 Schema |
| 存储 | 阿里云 OSS | 技能 ZIP 包对象存储，成本低 |
| 验证 | Zod | 前后端共享 Schema，运行时可推导类型 |
| 容器化 | Docker Compose | 三容器（Web + API + DB）一键部署 |
| CI/CD | GitHub + Docker | Pull → Build → Deploy，一条命令 |

### 目录结构

因为是 Monorepo 结构，后端可以在 NestJS 和 Next.js API Routes 之间灵活切换：

```
agent-skill-platform/
├── packages/
│   ├── web/                    # Next.js 前端
│   │   └── src/app/
│   │       ├── page.tsx        # 首页
│   │       ├── skills/         # 技能浏览
│   │       ├── submit/         # 技能上传
│   │       ├── auth/           # 登录注册
│   │       ├── leaderboard/    # 排行榜
│   │       ├── hub/            # 管理后台
│   │       ├── sitemap.ts      # 动态站点地图
│   │       └── robots.ts       # 爬虫规则
│   │
│   ├── api/                    # NestJS 后端
│   │   └── src/
│   │       ├── skills/         # 技能模块（核心）
│   │       ├── auth/           # 认证模块
│   │       ├── teams/          # 团队模块
│   │       ├── leaderboard/    # 排行榜模块
│   │       ├── storage/        # OSS 存储模块
│   │       └── common/         # 通用模块（管理后台/健康检查）
│   │
│   └── shared/                 # 前后端共享代码
│       └── src/
│           └── skill-md.ts     # SKILL.md 解析器 + Zod Schema
│
├── docker-compose.yml          # 开发环境
├── docker-compose.prod.yml     # 生产环境
├── Dockerfile.web              # 前端构建镜像
├── Dockerfile.api              # 后端构建镜像
└── schema.sql                  # 数据库 DDL
```

---

## 三、核心功能实现

### 3.1 技能上传：ZIP 包解析 + SKILL.md 提取

这是整个平台最核心的功能——用户上传一个 ZIP 包，系统自动从里面找 `SKILL.md` 文件，解析元数据。

**后端 Service 核心逻辑**：

```typescript
async createVersion(skillId: string, fileBuffer: Buffer, userId: string, notes?: string) {
  const skill = await this.findOne(skillId, undefined, true);
  if (skill.owner_user_id !== userId) {
    throw new ForbiddenException('Not authorized');
  }

  // ── 第一步：从 ZIP 包中寻找 SKILL.md ──
  const zip = new AdmZip(fileBuffer);
  const candidates = zip
    .getEntries()
    .filter((e) => !e.isDirectory && /(^|\/)skill\.md$/i.test(e.entryName));

  if (candidates.length === 0) {
    throw new BadRequestException(
      'SKILL.md not found in zip. Your archive must contain a SKILL.md file.',
    );
  }

  // 优先取路径最短的（根目录下的 skill.md 优先于子目录的）
  candidates.sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length);
  const skillMdContent = candidates[0].getData().toString('utf8');
  const meta = parseSkillMd(skillMdContent);

  // ── 第二步：版本号去重 ──
  const dup = await this.versionRepository.findOne({
    where: { skill_id: skill.id, version: meta.version },
  });
  if (dup) {
    throw new BadRequestException(
      `Version ${meta.version} already exists. Bump the \`version\` field in SKILL.md.`,
    );
  }

  // ── 第三步：上传 ZIP 到 OSS ──
  const objectKey = `skills/${skill.id}/${meta.version}.zip`;
  const packageUrl = await this.ossService.putBuffer(objectKey, fileBuffer);

  // ── 第四步：创建版本记录 ──
  const version = this.versionRepository.create({
    skill_id: skill.id,
    version: meta.version,
    manifest_json: meta as any,
    package_url: packageUrl,
    size: fileBuffer.length,
    notes: notes?.trim() || null,
  });
  const savedVersion = await this.versionRepository.save(version);

  // ── 第五步：更新技能元数据（PENDING 状态才更新） ──
  const metadataUpdate: Partial<Skill> = {};
  if (skill.status !== SkillStatus.PUBLISHED) {
    if (meta.description) metadataUpdate.short_summary = meta.description;
    if (meta.tags?.length) {
      metadataUpdate.tags = [...new Set([...(skill.tags || []), ...meta.tags])];
    }
  }

  await this.skillRepository.update(skill.id, {
    latest_version_id: savedVersion.id,
    ...metadataUpdate,
  });

  await this.recordEvent(skill.id, EventType.SKILL_PUBLISH, userId);
  return savedVersion;
}
```

**NestJS 控制器中的文件上传端点**：

```typescript
@UseGuards(AuthGuard)
@Post(':id/versions')
@UseInterceptors(FileInterceptor('file', {
  limits: {
    fileSize: 300 * 1024,          // 300KB ZIP 上限
    fieldSize: 10 * 1024 * 1024,   // 10MB 表单字段上限
  },
}))
uploadVersion(
  @Param('id') id: string,
  @UploadedFile() file: any,
  @Request() req: any,
  @Body('notes') notes?: string,
) {
  if (!file) throw new BadRequestException('File is required');
  if (file.mimetype !== 'application/zip' && file.mimetype !== 'application/x-zip-compressed') {
    throw new BadRequestException('Only ZIP files are allowed');
  }
  return this.skillsService.createVersion(id, file.buffer, req.user.sub, notes);
}
```

#### 设计亮点：双端校验

前端在浏览器端也用 `jszip` 预解析了一次，让用户在上传之前就能看到技能名称和描述。前后端的解析逻辑保持一致，前端给体验，后端做保障。

### 3.2 SKILL.md 规范与解析

每个技能 ZIP 包里必须有一个 `SKILL.md` 文件，采用 **YAML Frontmatter + Markdown 正文** 的格式：

```markdown
---
name: Alibaba Listing Optimizer
version: v1.2.0
description: Automatically optimize product listings for Alibaba International Station
tags:
  - alibaba
  - listing
  - seo
license: MIT
author: SkillDepot
---

## Usage

This skill analyzes your product title, keywords, and description...

## Input

- Product title
- Target keywords
- Current description text

## Output

- Optimized title (SEO-friendly)
- Keyword-enriched description
- Suggested improvements
```

**Shared 层的解析器**（前后端共用）：

```typescript
import { z } from 'zod';

// 用 Zod 定义元数据 Schema，既做校验又推导类型
export const SkillMetaSchema = z.object({
  name: z.string().min(1),
  version: z.string().transform((v) => {
    const cleaned = v.trim().replace(/^[vV]/, '');
    const m = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!m) throw new Error(`Invalid version format "${v}"`);
    return `${m[1]}.${m[2] || '0'}.${m[3] || '0'}`;
  }),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  license: z.string().optional(),
  author: z.string().optional(),
});

// 提取 --- 包围的 YAML frontmatter
function extractFrontmatter(content: string): string | null {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  return match ? match[1] : null;
}
```

这里的 Zod Schema 有几个妙用：
1. **运行时可推导 TypeScript 类型**——`z.infer<typeof SkillMetaSchema>` 直接拿到类型
2. **前后端共享**——`packages/shared` 目录下的代码 Web 和 API 都能引用
3. **版本号格式化**——`transform` 自动处理 `v1.2` → `1.2.0`、`1.0` → `1.0.0` 等格式

### 3.3 防刷分排行榜

排行榜如果直接用原始点赞数排序，很容易被刷。我的做法是**对数衰减**：

```typescript
// 简化后的分数计算逻辑
const SCORE = Math.log10(likes + downloads + 1) * (1 - 0.5 * Math.exp(-daysSincePublished / 30));
```

- **新技能有曝光红利**（衰减系数让新技能有机会上榜）
- **老技能靠质量维持**（如果持续被点赞下载，分数稳得住）
- 榜单分周榜和总榜，每周一 0 点重置周榜

### 3.4 SEO 多语言支持

作为面向全球的技能市场，SEO 必须同时覆盖中文和英文。Next.js App Router 的 `generateMetadata` 配合 `layout.tsx` 实现了非常好用的 SEO 架构：

```typescript
// packages/web/src/app/layout.tsx
export const metadata: Metadata = {
  metadataBase: new URL('https://skills.rehomi.com'),
  title: { default: 'SkillDepot — AI Agent Skills Marketplace', template: '%s | SkillDepot' },
  description: 'Discover, share, and download AI Agent skills...',
  keywords: ['AI agent', '跨境电商', 'Alibaba International Station', 'Amazon seller tools', ...],
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    alternateLocale: 'en_US',
    // ...
  },
  alternates: {
    languages: {
      'zh-CN': 'https://skills.rehomi.com/',
      'en-US': 'https://skills.rehomi.com/en',
    },
  },
};
```

动态 sitemap 自动生成所有技能详情的 URL：

```typescript
// packages/web/src/app/sitemap.ts
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const skills = await fetchSkills();
  const skillUrls = skills.map(skill => ({
    url: `https://skills.rehomi.com/skills/${skill.slug}`,
    lastModified: skill.updated_at,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));
  // ... 合并首页/分类页/用户页
}
```

### 3.5 实体关系设计

| 实体 | 表名 | 关键字段 | 关系 |
|------|------|---------|------|
| `Skill` | `skills` | `slug`, `name`, `tags[]`, `status` | HasMany `SkillVersion`, HasOne `SkillStats` |
| `SkillVersion` | `skill_versions` | `version`, `manifest_json`(JSONB), `package_url` | BelongsTo `Skill` |
| `SkillStats` | `skill_stats` | `likes_total`, `downloads_total`, `total_score`, `weekly_score` | BelongsTo `Skill` |
| `Event` | `events` | `event_type`, `skill_id`, `user_id` | 所有操作日志化 |

JSONB 字段 `manifest_json` 存储完整的 SKILL.md 元数据，这样每次版本的元数据都是快照，历史可追溯，不受技能主表变更影响。

---

## 四、部署与运维

### Docker Compose 三容器架构

```yaml
services:
  db:                         # PostgreSQL 18
    image: postgres:18-alpine
    healthcheck: { test: pg_isready, interval: 5s }
    volumes: [ postgres_data:/var/lib/postgresql ]
    networks: [app_net]

  api:                        # NestJS API (Port 3001)
    build: { dockerfile: Dockerfile.api }
    environment:
      - NODE_ENV=production
      - DB_HOST=db / DB_PORT=5432
      - JWT_SECRET=${JWT_SECRET}
      - OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
    # 不暴露宿主机端口，仅内网通信
    depends_on: { db: { condition: service_healthy } }
    networks: [app_net]

  web:                        # Next.js 前端 (Port 3000)
    build: { dockerfile: Dockerfile.web }
    environment:
      - API_HOST=api
      - NEXT_PUBLIC_BASE_URL=https://skills.rehomi.com
    ports: ['3000:3000']
    depends_on: [ api ]
    networks: [app_net]

networks:
  app_net: { driver: bridge }
```

**架构要点**：
- API 容器不对外暴露端口，只承载在 Docker 内网，Web 通过容器名 `api:3001` 访问
- Web 容器对外暴露 3000 端口，用 Nginx 反向代理挂域名
- DB 有健康检查，API 等 DB 就绪后再启动
- 使用独立的 `.env.production` 管理密钥，不提交到 git
- 更新命令简单到一条：`git pull && docker compose -f docker-compose.prod.yml up -d --build`

---

## 五、开发过程中的一些思考

### 为什么选 Next.js + NestJS 而不是 Next.js API Routes？

项目初期确实纠结过。

如果全用 Next.js API Routes，可以少维护一个项目，部署也简单。但几轮下来发现：

1. **API 逻辑越来越重**——ZIP 解析、OSS 上传、排行榜计算、事件追溯，NestJS 的模块化让代码组织清爽很多
2. **类型共享需求**——Zod Schema、实体类型在 Web 和 API 之间共享，Monorepo 是必选项
3. **数据库迁移**——NestJS + TypeORM 有成熟的 Migration 机制，Next.js API Routes 需要自己搭

最终选择了 **Next.js + NestJS 双项目**，共享 `packages/shared` 的代码。

### 排行榜防刷的点子

从 Reddit 的 Hot 算法得到启发——`log(点赞数) / 时间衰减` 这个公式在社区类应用中非常经典。加上周榜/总榜双榜机制，让新技能每周都有机会上榜，而不是老技能永远霸榜。

### 关于国际化

本想直接用 `next-intl` 或 `next-i18next`，但发现项目只需要中英双语，且切换逻辑简单（URL Path 前缀 + `Accept-Language`），最终自己写了个轻量 Hook + `x-lang` header 实现的，才 50 行代码，比引入一个 i18n 框架清爽很多。

---

## 六、项目状态与未来规划

目前 SkillDepot 处于**早期阶段**，功能基本可用，但内容还在积累中。

### 已实现
- ✅ 技能上传/下载（单个 + 批量）
- ✅ 搜索/分类/标签筛选
- ✅ 排行榜（周榜+总榜）
- ✅ 用户认证（JWT + 邮箱 + 微信）
- ✅ 评论/评分
- ✅ 管理后台审核
- ✅ 中英双语
- ✅ SEO（sitemap + robots + JSON-LD）

### 计划中
- 🔲 OAuth 一键登录（GitHub/Google）
- 🔲 AI 技能自动预览沙箱
- 🔲 技能评分投票机制优化
- 🔲 更多跨境电商技能内容填充

---

## 七、链接

- **在线体验**：[https://skills.rehomi.com](https://skills.rehomi.com)
- **开源仓库**：[https://github.com/jack12w/agent-skill-platform](https://github.com/jack12w/agent-skill-platform)
- **技术栈**：Next.js 14 + NestJS + PostgreSQL + Tailwind CSS + Docker

如果对项目感兴趣、有建议或者想一起做，欢迎在 GitHub 提 Issue 或 PR。

---

*如果你也关注跨境电商 + AI 方向，或者正在做类似的开源项目，欢迎在评论区交流。*
