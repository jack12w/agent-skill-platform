import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Agent 技能广场 — SkillDepot',
  description:
    '发现并下载专为跨境电商打造的 AI Agent 技能。涵盖阿里巴巴国际站 Listing 优化、亚马逊广告投放、Shopify 独立站运营、WordPress 电商、客服自动化等场景，一键下载，即刻提升运营效率。',
  keywords: [
    'AI Agent 技能',
    '跨境电商 AI',
    '阿里国际站技能',
    '阿里巴巴国际站 Listing 优化',
    'Amazon AI 技能',
    'Shopify 自动化',
    '独立站 AI',
    'WordPress 电商',
    'AI 客服技能',
    'AI 选品工具',
    '广告投放 AI',
    'SkillDepot 技能广场',
  ],
  openGraph: {
    title: 'AI Agent 技能广场 — SkillDepot',
    description:
      '专为跨境电商卖家设计的 AI Agent 技能市场。阿里国际站、亚马逊、Shopify、独立站一站式 AI 技能下载。',
    url: 'https://skills.rehomi.com/skills',
  },
  alternates: {
    canonical: 'https://skills.rehomi.com/skills',
    languages: {
      'zh-CN': 'https://skills.rehomi.com/skills',
      'en-US': 'https://skills.rehomi.com/en/skills',
    },
  },
};

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
