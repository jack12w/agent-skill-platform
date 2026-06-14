import type { Metadata } from 'next';
import { SkillSchema, BreadcrumbSchema } from '../../../lib/structured-data';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://skills.rehomi.com';
const API_BASE = `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || '3001'}`;

async function fetchSkill(slug: string) {
  try {
    const res = await fetch(`${API_BASE}/api/skills/${slug}`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const skill = await fetchSkill(params.slug);

  if (!skill) {
    return {
      title: 'Skill Not Found',
      description: 'The requested AI agent skill could not be found.',
    };
  }

  const title = `${skill.name} — AI Agent Skill`;
  const description =
    skill.short_summary || skill.summary || `Discover ${skill.name}, an AI agent skill on SkillDepot.`;
  const url = `${BASE_URL}/skills/${skill.slug || skill.id}`;

  return {
    title,
    description,
    keywords: skill.tags || [],
    openGraph: {
      title,
      description,
      url,
      type: 'article',
      images: skill.cover_url ? [{ url: skill.cover_url, width: 1200, height: 630 }] : [{ url: '/og-image.svg' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: skill.cover_url ? [skill.cover_url] : ['/og-image.svg'],
    },
    alternates: {
      canonical: url,
      languages: {
        'zh-CN': url,
        'en-US': `${BASE_URL}/en/skills/${skill.slug || skill.id}`,
      },
    },
  };
}

export default async function SkillLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug: string };
}) {
  const skill = await fetchSkill(params.slug);
  return (
    <>
      {skill && (
        <>
          <SkillSchema {...skill} />
          <BreadcrumbSchema
            items={[
              { name: 'Home', url: BASE_URL },
              { name: 'Skills', url: `${BASE_URL}/skills` },
              { name: skill.name, url: `${BASE_URL}/skills/${skill.slug || skill.id}` },
            ]}
          />
        </>
      )}
      {children}
    </>
  );
}
