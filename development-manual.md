# Agent 技能库网站开发文档（MVP + GEO）

## 0. 术语与规则变更
### 概念澄清
- **技能（Skill）**：用户或团队上传的“Agent 技能包”。本系统仅负责托管元数据（manifest、README、封面）与包文件，**不支持在线执行**。
- **技能数（Skill Count）**：某个主体（个人或团队）名下拥有且处于“已发布（Published）”状态的技能总数。

### 计分公式（全站统一）
系统采用统一的权重体系：`WEIGHTS = { skill: 5, like: 0.1, download: 0.1 }`。

- **个人/团队榜得分**：
  `总分 = 技能数 × 5 + 点赞数 × 0.1 + 下载数 × 0.1`
  *注：点赞与下载取其名下所有技能的去重聚合值。*
- **单技能分（用于技能广场排序）**：
  `单技能分 = 5 + 该技能点赞 × 0.1 + 该技能下载 × 0.1`
  *逻辑说明：单技能的“技能数”恒定为 1，故引入 5 分常数，确保与主体榜规则对齐。*

### 榜单周期
- **周榜**：按最近 7 天的**增量**计算（新发布技能数、最近 7 天新增的点赞与下载）。
- **总榜**：按累计**存量**值计算（总技能数、总去重点赞、总去重下载）。

---

## 1. 业务范围与页面
### 业务约束
- **仅托管**：不支持在线执行，仅托管包与元数据（manifest、README、封面）。
- **无人工审核**：上传自动发布（机器校验失败自动下架）。
- **团队共管**：技能可归属团队，团队 owner/maintainer 可编辑。

### 站点信息架构（4 个一级入口）
1.  **首页**：精选技能、周热榜预览、新上架滚动展示。
2.  **榜单**：Tabs（个人/团队）× Period（周榜/总榜），展示得分构成（技能数/赞/下载）。
3.  **技能广场**：提供全文搜索、标签筛选、多维排序（周热度、最新、总分）。
4.  **提交**：技能上传表单（基础信息 + ZIP 包 + 封面图 + 标签）。

---

## 2. 架构与模块化
### 技术栈
- **前端**：Next.js (SSR/SEO/GEO)、Ant Design/Tailwind。
- **后端**：Node.js (NestJS/Express)，RESTful API。
- **数据**：PostgreSQL (主库)、Redis (缓存/限流/队列)。
- **存储**：S3/OSS/MinIO (包与图片)；队列/定时：BullMQ/Cron。

### Monorepo 结构 (pnpm + Turborepo)
- `packages/web`：前端应用（SSR、JSON-LD、hreflang、AI 爬虫简版 DOM）。
- `packages/api`：核心后端服务（events/stats/leaderboard/ai-feed）。
- `packages/shared`：共享 DTO、常量（计分权重）、类型定义。
- `packages/ui`：复用 UI 组件库。

### 后端领域模块
- auth | users | teams | skills | events | stats | leaderboard | files | moderation | geo（AI feed、bots 策略）

### 数据流逻辑
1.  **上传/行为**：上传技能 -> 写 skills，用户行为（点赞/下载）-> 写 events。
2.  **异步聚合**：每 1-5 分钟聚合 events -> skill_stats。
3.  **榜单作业**：定时计算个人/团队周/总榜 -> leaderboard_snapshots。
4.  **GEO 输出**：/api/ai/feed 提供摘要；页面注入 JSON-LD；robots/sitemap 暴露线索。

---

## 3. 核心数据模型
### 关键表结构
- **users**(id, email, name, created_at,...)
- **teams**(id, name, description, owner_user_id,...)
- **team_members**(team_id, user_id, role[owner|maintainer|viewer])
- **skills**(id, owner_user_id, owner_team_id, name, slug, summary, short_summary, io_schema JSONB, tags[], cover_url, status[published|archived], latest_version_id, created_at)
- **skill_versions**(id, skill_id, version, manifest_json, package_url, checksum, size, created_at)
- **events**(id, user_id, team_id, skill_id, type[skill_publish|download|like|view], payload_json, ip_hash, created_at)
- **skill_stats**(skill_id, likes_total, downloads_total, likes_7d, downloads_7d, total_score, weekly_score, updated_at)
- **leaderboard_snapshots**(id, type[personal|team], period[weekly|all], snapshot_date, data_json, created_at)

```sql
-- GEO 增强字段示例
ALTER TABLE skills ADD COLUMN short_summary TEXT;
ALTER TABLE skills ADD COLUMN io_schema JSONB;
```

---

## 4. 计分与榜单算法实现
### 计分逻辑 (shared/constants.ts)
```ts
export const WEIGHTS = { skill: 5, like: 0.1, download: 0.1 };

/** 单技能分（用于排序） **/
export function scoreSingleSkill(likes: number, downloads: number) {
  return WEIGHTS.skill + WEIGHTS.like * likes + WEIGHTS.download * downloads;
}

/** 主体得分（个人/团队） **/
export function scoreSubject(count: number, likes: number, downloads: number) {
  return count * WEIGHTS.skill + likes * WEIGHTS.like + downloads * WEIGHTS.download;
}
```
*去重逻辑：点赞一人一票（可取消）；下载在短时间窗内按 user_id 或 ip_hash 去重。*

---

## 5. 核心流程
- **上传与发布**：填写信息 -> 上传 ZIP（含 manifest.json/README.md）-> 自动发布并记录事件。
- **点赞与下载**：点赞幂等操作；下载通过签名 URL 并记录事件。
- **聚合与榜单**：近 7 天窗口聚合与主体榜单定时计算快照。
- **GEO 输出**：发布/更新后自动同步 JSON-LD、/api/ai/feed 与 sitemap。

---

## 6. API 设计（REST）
- **Auth**: `/api/auth/register | /login | /logout`
- **Teams**: `POST /api/teams`, `POST /api/teams/{id}/members`
- **Skills**: 
  - `POST /api/skills` (元信息)
  - `POST /api/skills/{id}/versions` (上传包)
  - `GET /api/skills?query=&tag=&sort=weekly|new|total`
  - `POST /api/skills/{id}/like` (点赞/取消)
  - `GET /api/skills/{id}/download` (302 跳转)
- **Leaderboard**: `GET /api/leaderboard/personal?period=weekly|all` 等
- **GEO**: `GET /api/ai/feed?page=1&page_size=100` (机器可读摘要)

---

## 7. GEO（面向 AI 搜索的优化）实施清单
- **内容模板**：定义 + 能力列表 + IO 示例 + FAQ。
- **结构化数据**：
  - 技能页：SoftwareApplication JSON-LD。
  - 榜单页：ItemList JSON-LD。
  - FAQ：FAQPage。
- **AI Feed**：输出 JSON/JSONL 摘要，含分数、标签、IO 定义。
- **抓取与路由**：
  - 针对 AI UA 输出“简版 DOM”（正文在 <main>，分块清晰）。
  - robots.txt 允许爬虫，sitemap 含 lastmod。

---

## 8. 开发里程碑（3 周）
- **第 1 周**：数据模型、Auth、团队权限、技能上传详情、MinIO 直传、首页列表。
- **第 2 周**：事件采集与异步聚合、主体得分计算、周/总榜快照、榜单页。
- **第 3 周**：搜索筛选、GEO 专项优化（JSON-LD/Feed）、风控防刷、监控与部署。

---

## 9. 验收清单
- [ ] 4 个入口可用，SEO 完整（OG/sitemap/hreflang）。
- [ ] GEO 生效（JSON-LD、AI feed、robots 配置、UA 抓取通过）。
- [ ] 榜单定时更新且周/总数据正确。
- [ ] 团队共管权限生效。
- [ ] 列表/榜单接口 P95 < 300ms（缓存命中）。

---

## 10. 精选标签设计

### 品牌命名
项目定名 **SkillDepot**（技能仓库），原 SkillHub 因同名冲突已停用。全部代码、Logo、SEO 文案已更新。

### 设计理念
「精选」标签是平台对优秀技能的官方标记。**用户不可自行添加**，仅管理员操作。

### 配色方案（阿里橙）

```
背景: #FFF3E0 (orange-50)    文字: #E65100 (orange-800)
边框: #FFCC80 (orange-200)    圆角: rounded-full
字号: 13px    字重: 500
```

Tailwind 类名：`bg-orange-50 text-orange-800 border border-orange-200`

### 前端过滤机制

| 层级 | 位置 | 方式 |
|------|------|------|
| 选择器 | submit / edit 页 tagGroups 渲染 | `.filter(tag => !['精选','Featured','featured','FEATURED'].includes(tag))` |
| 提交 | submit / edit 页 POST body | 同上 filter 静默移除 |

### 精选渲染位置

| 页面 | 文件 | 普通样式 | 精选样式 |
|------|------|----------|----------|
| 技能详情 | `skills/[slug]/page.tsx` | `bg-blue-50 text-blue-600` | 阿里橙 |
| 个人主页 | `users/[username]/page.tsx` | `bg-gray-100 text-gray-600` | 阿里橙 |
| 团队主页 | `teams/[id]/page.tsx` | `bg-gray-100 text-gray-600` | 阿里橙 |
| 后台标签 | `hub/tag-groups/page.tsx` | `bg-blue-50 text-blue-700` | 阿里橙 |
| 后台技能 | `hub/skills/page.tsx` | `bg-gray-100 text-gray-600` | 阿里橙 |
| 后台审核 | `hub/reviews/page.tsx` | `bg-yellow-50 text-yellow-700` | 阿里橙 |

> 技能广场筛选栏保持原有蓝底样式，不做切换。

### 排行榜修正
`leaderboard.service.ts`：增加 `AND s.status = 'published'` 过滤 + 移除零事件 `HAVING` 限制。

---

## 11. 帮助中心

路径 `/help`，左侧菜单 + 右侧内容布局。四个子页：快速入门 / 关于我们 / 联系我们 / 反馈建议。

反馈提交需登录，支持选择类型（建议 / BUG 报错 / 其它），管理员在后台「反馈建议」模块查看。

---
## 12. SEO 安全

| 层级 | 机制 |
|------|------|
| robots.txt | `Disallow: /hub /auth /dashboard /submit /api/ /*/edit` |
| HTML meta | hub/auth/dashboard/submit/layout 注入 `noindex,nofollow` |
| API 响应头 | `X-Robots-Tag: noindex, nofollow, noarchive` |
| Sitemap | 不含私有路径 |

---
## 13. 技能广场无限滚动

`IntersectionObserver` 提前 200px 触发，每页 20 条。筛选重置回第一页。
