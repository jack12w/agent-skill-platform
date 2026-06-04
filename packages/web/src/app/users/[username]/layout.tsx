import type { Metadata } from 'next';
import { BreadcrumbSchema } from '../../../lib/structured-data';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://skills.rehomi.com';
const API_BASE = `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || '3001'}`;

async function fetchUser(username: string) {
  try {
    const decoded = decodeURIComponent(username);
    const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(decoded)}`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { username: string };
}): Promise<Metadata> {
  const user = await fetchUser(params.username);

  if (!user) {
    return {
      title: 'User Not Found',
      description: 'The requested user profile could not be found.',
    };
  }

  const title = `${user.name} — AI Agent Creator`;
  const description =
    user.bio
      || `${user.name} has published ${user.skill_count} AI agent skills with ${user.total_likes} likes and ${user.total_downloads} downloads.`;
  const url = `${BASE_URL}/users/${encodeURIComponent(user.name)}`;

  return {
    title,
    description,
    keywords: ['AI agent', 'creator', 'skills', user.name],
    openGraph: {
      title,
      description,
      url,
      type: 'profile',
      images: user.avatar_url
        ? [{ url: user.avatar_url, width: 200, height: 200 }]
        : [{ url: '/og-image.svg' }],
    },
    twitter: {
      card: 'summary',
      title,
      description,
      images: user.avatar_url ? [user.avatar_url] : ['/og-image.svg'],
    },
    alternates: {
      canonical: url,
    },
  };
}

export default async function UserLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { username: string };
}) {
  const user = await fetchUser(params.username);
  const encoded = user ? encodeURIComponent(user.name) : params.username;

  return (
    <>
      {user && (
        <>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'Person',
                name: user.name,
                url: `${BASE_URL}/users/${encoded}`,
                ...(user.avatar_url ? { image: user.avatar_url } : {}),
                ...(user.bio ? { description: user.bio } : {}),
              }),
            }}
          />
          <BreadcrumbSchema
            items={[
              { name: 'Home', url: BASE_URL },
              { name: 'Users', url: `${BASE_URL}/users` },
              { name: user.name, url: `${BASE_URL}/users/${encoded}` },
            ]}
          />
        </>
      )}
      {children}
    </>
  );
}
