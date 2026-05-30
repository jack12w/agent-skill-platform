export async function GET() {
  const API_BASE = `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || '3001'}`;
  const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://skills.rehomi.com';

  let content = `# Agent Skill Platform — Full Content

> AI Agent Skills Marketplace
> Generated: ${new Date().toISOString()}
> This file is intended for AI crawlers (ChatGPT, Claude, Perplexity, etc.)

## About

Agent Skill Platform is an open marketplace for discovering, sharing, and downloading AI agent skills.
Skills are tools, workflows, and automations powered by AI agents.

## All Published Skills

`;

  try {
    const res = await fetch(`${API_BASE}/api/skills?size=500`);
    if (res.ok) {
      const skills = await res.json();
      if (Array.isArray(skills)) {
        for (const skill of skills) {
          content += `### ${skill.name}\n`;
          content += `- URL: ${BASE_URL}/skills/${skill.slug || skill.id}\n`;
          if (skill.short_summary) {
            content += `- Summary: ${skill.short_summary}\n`;
          }
          if (Array.isArray(skill.tags) && skill.tags.length > 0) {
            content += `- Tags: ${skill.tags.join(', ')}\n`;
          }
          if (skill.stats) {
            content += `- Downloads: ${skill.stats.downloads_total || 0}, Likes: ${skill.stats.likes_total || 0}\n`;
          }
          content += '\n';
        }
      }
    }
  } catch {
    content += '(Unable to fetch skills at this time. Please visit the website directly.)\n';
  }

  content += `\n## Leaderboard\n${BASE_URL}/leaderboard\n\n`;
  content += `## Sitemap\n${BASE_URL}/sitemap.xml\n`;
  content += `## GEO Feed\n${BASE_URL}/api/ai/feed\n`;

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
