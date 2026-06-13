'use client';

/**
 * 从后端 API 获取标签分组。带简单本地缓存（5分钟有效）避免重复请求。
 * 返回格式与原先硬编码 TAG_GROUPS 一致：{ scene: [...], role: [...], ... }
 * 如果没有网络或 API 不可用，返回空对象。
 */

let cache: Record<string, string[]> | null = null;
let cacheTime = 0;
const TTL = 5 * 60 * 1000; // 5 分钟

export async function fetchTagGroups(): Promise<Record<string, string[]>> {
  const now = Date.now();
  if (cache && now - cacheTime < TTL) return cache;

  try {
    const res = await fetch('/api/tags/groups');
    if (!res.ok) throw new Error('Failed');
    const groups: { key: string; tags: string[] }[] = await res.json();
    const result: Record<string, string[]> = {};
    for (const g of groups) result[g.key] = g.tags || [];
    cache = result;
    cacheTime = now;
    return result;
  } catch {
    return {};
  }
}
