/**
 * JSON-LD Structured Data helpers for SEO.
 * All components render <script type="application/ld+json"> tags.
 */

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://skills.rehomi.com';

/* ── WebSite ────────────────────────────────────── */

export function WebSiteSchema() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'SkillDepot',
    url: BASE_URL,
    description: 'Discover, share, and download AI Agent skills. The open marketplace for AI-powered tools and workflows.',
    inLanguage: ['zh-CN', 'en-US'],
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${BASE_URL}/skills?query={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

/* ── Organization ───────────────────────────────── */

export function OrganizationSchema() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'SkillDepot',
    url: BASE_URL,
    logo: `${BASE_URL}/logo.svg`,
    description: 'AI Agent Skills Marketplace — discover, share, and download AI-powered skills for cross-border ecommerce (Alibaba International Station, Amazon, Shopify, WordPress, independent stores) and developer workflows.',
    sameAs: [
      'https://github.com/jack12w/agent-skill-platform',
    ] as string[],
  };

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

/* ── SoftwareApplication (Skill detail) ──────────── */

export function SkillSchema(skill: {
  id?: string;
  name?: string;
  slug?: string;
  summary?: string;
  short_summary?: string;
  tags?: string[];
  cover_url?: string;
  owner_user?: { name?: string; email?: string };
  stats?: {
    likes_total?: number;
    downloads_total?: number;
    total_score?: number;
  };
  created_at?: string;
  updated_at?: string;
}) {
  if (!skill || !skill.name) return null;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: skill.name,
    description: skill.short_summary || skill.summary || '',
    applicationCategory: 'AIApplication',
    operatingSystem: 'All',
    url: `${BASE_URL}/skills/${skill.slug || skill.id}`,
    image: skill.cover_url || `${BASE_URL}/favicon.svg`,
    author: skill.owner_user
      ? {
          '@type': 'Person',
          name: skill.owner_user.name || 'Anonymous',
        }
      : undefined,
    datePublished: skill.created_at,
    dateModified: skill.updated_at,
    keywords: skill.tags?.join(', ') || '',
    aggregateRating: skill.stats
      ? {
          '@type': 'AggregateRating',
          ratingValue: skill.stats.total_score || 5,
          bestRating: 10,
          ratingCount: Math.max(
            Number(skill.stats.likes_total) + Number(skill.stats.downloads_total),
            1,
          ),
        }
      : undefined,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

/* ── ItemList (Skills listing page) ──────────────── */

export function SkillListSchema({ skills }: { skills: Array<{ name: string; slug?: string; id?: string }> }) {
  if (!Array.isArray(skills) || skills.length === 0) return null;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: skills.map((s, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: s.name,
      url: `${BASE_URL}/skills/${s.slug || s.id}`,
    })),
  };

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

/* ── BreadcrumbList ──────────────────────────────── */

export function BreadcrumbSchema({ items }: { items: Array<{ name: string; url: string }> }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}
