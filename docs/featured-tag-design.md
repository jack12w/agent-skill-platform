# 精选标签 — 技术方案与配色规范

## 1. 设计理念

「精选」标签是平台对优秀技能的官方标记（类似 GitHub 的 "Pinned" 或 App Store 的 "编辑推荐"）。用户**不可自行添加**，仅管理员通过后台标签分组管理技能时生效。

### 配色方案：阿里橙

参照阿里云的品牌橙色系，在保持平台蓝色主色调的基础上，用暖橙色标识平台推荐内容。

```
背景: #FFF3E0  (orange-50)
文字: #E65100  (orange-800)
边框: #FFCC80  (orange-200) 0.5px
字号: 13px
字重: 500
圆角: rounded-full
```

## 2. 技术实现

### 2.1 前端过滤（多层次防护）

**第一层：标签选择器不可见**

| 文件 | 位置 | 改动 |
|------|------|------|
| `packages/web/src/app/submit/page.tsx` | tagGroups 渲染 | `.filter(tag => !['精选','Featured','featured','FEATURED'].includes(tag))` |
| `packages/web/src/app/skills/[slug]/edit/page.tsx` | tagGroups 渲染 | 同上 |

**第二层：提交时静默过滤**

| 文件 | 位置 | 改动 |
|------|------|------|
| `packages/web/src/app/submit/page.tsx` | handleSubmit body.tags | `.filter(x => !['精选','Featured','featured','FEATURED'].includes(x))` |
| `packages/web/src/app/skills/[slug]/edit/page.tsx` | saveEdit payload.tags | 同上 |

### 2.2 前端渲染（精选标签特殊样式）

所有渲染标签的位置均通过 `tag === '精选'` 判断切换样式：

| 页面 | 文件 | 普通样式 | 精选样式 |
|------|------|----------|----------|
| 技能详情页 | `skills/[slug]/page.tsx` | `bg-blue-50 text-blue-600` | `bg-orange-50 text-orange-800 border border-orange-200` |
| 个人主页技能卡片 | `users/[username]/page.tsx` | `bg-gray-100 text-gray-600` | 同上 |
| 团队主页技能卡片 | `teams/[id]/page.tsx` | `bg-gray-100 text-gray-600` | 同上 |
| 后台标签管理 | `hub/tag-groups/page.tsx` | `bg-blue-50 text-blue-700` | 同上 |
| 后台技能管理 | `hub/skills/page.tsx` | `bg-gray-100 text-gray-600` | 同上 |
| 后台技能审核 | `hub/reviews/page.tsx` | `bg-yellow-50 text-yellow-700` | 同上 |

> 技能广场筛选栏 (`skills/page.tsx`) 保持原有蓝底样式，不做切换。

### 2.3 后端

排行榜查询 (`leaderboard.service.ts`) 已加入 `AND s.status = 'published'` 过滤 pending 状态。

## 3. Tailwind 类名参考

```jsx
// 精选标签
className="px-3 py-1 text-sm rounded-full bg-orange-50 text-orange-800 border border-orange-200"

// 普通标签 (示例)
className="px-3 py-1 text-sm rounded-full bg-blue-50 text-blue-600"
```

## 4. 如何管理精选标签

1. 登录管理员账号 → 后台 → 标签管理 → 将技能标记为「精选」
2. 或者在后台 → 技能管理 → 编辑标签 → 手动添加「精选」
3. 提交/编辑页面已完全过滤，用户无法自助添加

## 5. 项目名称

项目曾用名 "SkillHub"，因同名冲突已更名为 **SkillDepot**（技能仓库）。

### 更名涉及范围

| 层级 | 改动 |
|------|------|
| Logo SVG | `SkillHub` → `SkillDepot` |
| SEO meta | `layout.tsx` 的 title/description/og/twitter |
| 翻译文件 | `zh.ts` / `en.ts` 全部文案 |
| 页脚 & 导航 | 站点名称 |
| 邮件主题 | 验证码邮件 `SkillDepot - 邮箱验证码` |
| LLMs.txt | 全文索引标题 |
| Sitemap / robots.txt | 站点引用 |
| 结构化数据 | `structured-data.tsx` Schema.org |
