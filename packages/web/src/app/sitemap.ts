import { MetadataRoute } from 'next';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://skills.rehomi.com';

function langVariant(url: string): MetadataRoute.Sitemap {
  return [
    { url, lastModified: new Date(), changeFrequency: 'daily' as const, priority: 0.9 },
    { url: url.replace(BASE_URL, `${BASE_URL}/en`), lastModified: new Date(), changeFrequency: 'daily' as const, priority: 0.8 },
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/en`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    ...langVariant(`${BASE_URL}/skills`),
    ...langVariant(`${BASE_URL}/leaderboard`),
  ];

  // 动态获取所有 skill 页面
  let skillRoutes: MetadataRoute.Sitemap = [];
  try {
    const apiBase = `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || '3001'}`;
    const res = await fetch(`${apiBase}/api/skills?size=500`);
    if (res.ok) {
      const skills: any[] = await res.json();
      skillRoutes = skills.flatMap((skill: any) => {
        const zhUrl = `${BASE_URL}/skills/${skill.slug || skill.id}`;
        const enUrl = `${BASE_URL}/en/skills/${skill.slug || skill.id}`;
        return [
          { url: zhUrl, lastModified: skill.updated_at ? new Date(skill.updated_at) : new Date(), changeFrequency: 'weekly' as const, priority: 0.7 },
          { url: enUrl, lastModified: skill.updated_at ? new Date(skill.updated_at) : new Date(), changeFrequency: 'weekly' as const, priority: 0.6 },
        ];
      });
    }
  } catch {
    // API 不可用时降级：sitemap 仍是有效的，只是缺少动态 skill 条目
  }

  // 获取团队页面
  let teamRoutes: MetadataRoute.Sitemap = [];
  try {
    const apiBase = `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || '3001'}`;
    const res = await fetch(`${apiBase}/api/teams?size=100`);
    if (res.ok) {
      const teams: any[] = await res.json();
      teamRoutes = teams.flatMap((team: any) => {
        const zhUrl = `${BASE_URL}/teams/${team.id}`;
        const enUrl = `${BASE_URL}/en/teams/${team.id}`;
        return [
          { url: zhUrl, lastModified: team.updated_at ? new Date(team.updated_at) : new Date(), changeFrequency: 'weekly' as const, priority: 0.6 },
          { url: enUrl, lastModified: team.updated_at ? new Date(team.updated_at) : new Date(), changeFrequency: 'weekly' as const, priority: 0.5 },
        ];
      });
    }
  } catch {
    // 降级
  }

  return [...staticRoutes, ...skillRoutes, ...teamRoutes];
}
