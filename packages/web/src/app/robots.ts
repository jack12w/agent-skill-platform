import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
      userAgent: '*',
      allow: ['/', '/skills', '/leaderboard', '/teams/', '/users/'],
      disallow: ['/auth', '/dashboard', '/submit', '/*/edit', '/api/'],
      },
      {
        userAgent: 'GPTBot',
        disallow: '/',
      },
      {
        userAgent: 'ChatGPT-User',
        disallow: '/',
      },
      {
        userAgent: 'Google-Extended',
        allow: ['/skills', '/leaderboard', '/'],
        disallow: ['/auth', '/dashboard', '/submit', '/*/edit', '/api/'],
      },
      {
        userAgent: 'CCBot',
        disallow: '/',
      },
      {
        userAgent: 'anthropic-ai',
        allow: ['/skills', '/leaderboard', '/'],
        disallow: ['/auth', '/dashboard', '/submit', '/*/edit', '/api/'],
      },
      {
        userAgent: 'cohere-ai',
        disallow: '/',
      },
      {
        userAgent: 'PerplexityBot',
        allow: ['/skills', '/leaderboard', '/'],
        disallow: ['/auth', '/dashboard', '/submit', '/*/edit', '/api/'],
      },
    ],
    sitemap: `${process.env.NEXT_PUBLIC_BASE_URL}/sitemap.xml`,
  };
}
