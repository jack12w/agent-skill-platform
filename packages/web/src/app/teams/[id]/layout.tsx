import type { Metadata } from 'next';
import { BreadcrumbSchema } from '../../../lib/structured-data';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://skills.rehomi.com';
const API_BASE = `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || '3001'}`;

async function fetchTeam(id: string) {
  try {
    const res = await fetch(`${API_BASE}/api/teams/${id}`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const team = await fetchTeam(params.id);

  if (!team) {
    return {
      title: 'Team Not Found',
      description: 'The requested team profile could not be found.',
    };
  }

  const title = `${team.name} — Team Skills`;
  const description =
    team.description
    || `${team.name} is a team on SkillDepot with ${(team.skills || []).length} AI agent skills.`;
  const url = `${BASE_URL}/teams/${team.id}`;

  return {
    title,
    description,
    keywords: ['AI agent', 'team', 'skills', team.name],
    openGraph: {
      title,
      description,
      url,
      type: 'website',
      images: [{ url: '/og-image.svg' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['/og-image.svg'],
    },
    alternates: {
      canonical: url,
    },
  };
}

export default async function TeamLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { id: string };
}) {
  const team = await fetchTeam(params.id);

  return (
    <>
      {team && (
        <>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'Organization',
                name: team.name,
                url: `${BASE_URL}/teams/${team.id}`,
                ...(team.description ? { description: team.description } : {}),
              }),
            }}
          />
          <BreadcrumbSchema
            items={[
              { name: 'Home', url: BASE_URL },
              { name: 'Teams', url: `${BASE_URL}/teams` },
              { name: team.name, url: `${BASE_URL}/teams/${team.id}` },
            ]}
          />
        </>
      )}
      {children}
    </>
  );
}
