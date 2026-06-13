'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

/* ── 预设标签分组 ── */
const TAG_GROUPS: Record<string, string[]> = {
  source: ['精选', '社区'],
  scene: ['workbuddy', '国际站', '生意助手'],
  role: ['老板', '管理', '运营', '业务', '美工', '市场', '采购', '供应链', '社媒'],
  category: ['选品洞察', 'Listing优化', '广告投放', '客户服务', '数据分析', '社媒营销', '供应链物流', '合规风控'],
};

const GROUP_KEYS = ['source', 'scene', 'role', 'category'] as const;

function SkillSquareInner() {
  const { t, tt } = useTranslation();
  const searchParams = useSearchParams();
  const searchParam = searchParams.get('query') || '';
  const tagsParam = searchParams.get('tags') || '';
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('weekly');
  const [query, setQuery] = useState(searchParam);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set(tagsParam ? tagsParam.split(',').filter(Boolean) : []));

  const activeTagsStr = Array.from(activeTags).join(',');

  const fetchSkills = useCallback(async () => {
    const controller = new AbortController();
    setLoading(true);
    try {
      let url = `/api/skills?sort=${sort}`;
      if (query) url += `&query=${encodeURIComponent(query)}`;
      if (activeTags.size > 0) url += `&tags=${encodeURIComponent(activeTagsStr)}`;
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : [];
      setSkills(list);
    } catch (e) { if ((e as Error).name !== 'AbortError') console.error(e); }
    finally { setLoading(false); }
    return controller;
  }, [sort, query, activeTagsStr]);

  useEffect(() => {
    const ctrl = fetchSkills();
    return () => { ctrl.then(c => c.abort()); };
  }, [fetchSkills]);

  /* 同步 URL */
  useEffect(() => {
    const params = new URLSearchParams();
    if (sort !== 'weekly') params.set('sort', sort);
    if (query) params.set('query', query);
    if (activeTags.size > 0) params.set('tags', activeTagsStr);
    const qs = params.toString();
    const newUrl = qs ? `/skills?${qs}` : '/skills';
    window.history.replaceState(null, '', newUrl);
  }, [activeTags, sort, query]);

  const getTagGroup = (tag: string): string | null => {
    for (const [group, tags] of Object.entries(TAG_GROUPS)) {
      if (tags.includes(tag)) return group;
    }
    return null;
  };

  const toggleTag = (tag: string) => {
    const group = getTagGroup(tag);
    setActiveTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        // 单选：先清除同组所有标签，再添加新标签
        if (group) {
          (TAG_GROUPS[group] || []).forEach(t => next.delete(t));
        }
        next.add(tag);
      }
      return next;
    });
  };

  const clearGroup = (group: string) => {
    const groupTags = TAG_GROUPS[group] || [];
    setActiveTags(prev => {
      const next = new Set(prev);
      groupTags.forEach(t => next.delete(t));
      return next;
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* ── 标题 + 排序 ── */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-2xl sm:text-4xl font-bold">{t('skills.square')}</h1>
        <div className="flex gap-2 p-1 bg-gray-100 rounded-lg self-start sm:self-auto">
          <button onClick={() => setSort('weekly')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'weekly' ? 'bg-white shadow-sm' : ''}`}>{t('skills.weeklyHot')}</button>
          <button onClick={() => setSort('total')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'total' ? 'bg-white shadow-sm' : ''}`}>{t('skills.allTime')}</button>
          <button onClick={() => setSort('new')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'new' ? 'bg-white shadow-sm' : ''}`}>{t('skills.newest')}</button>
        </div>
      </div>

      {/* ── 分类筛选 ── */}
      <div className="mb-6 space-y-3">
        {GROUP_KEYS.map(group => {
          const tags = TAG_GROUPS[group];
          const allKey = group === 'source' ? 'allSource' : group === 'scene' ? 'allScene' : group === 'role' ? 'allRole' : 'allCategory';
          const hasActive = tags.some(t => activeTags.has(t));
          return (
            <div key={group} className="flex gap-1.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' as any, msOverflowStyle: 'none' }}>
              <button
                onClick={() => clearGroup(group)}
                className={`shrink-0 px-3 py-1.5 text-sm rounded-full whitespace-nowrap transition ${!hasActive ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {t(`tags.${allKey}`)}
              </button>
              {tags.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`shrink-0 px-3 py-1.5 text-sm rounded-full whitespace-nowrap transition ${activeTags.has(tag) ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {tt(tag)}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* ── 搜索提示 ── */}
      {query && (
        <div className="mb-6 flex items-center gap-2">
          <span className="text-sm text-gray-500">搜索：</span>
          <span className="px-3 py-1 bg-blue-50 text-blue-700 text-sm rounded-full">{query}</span>
          <button onClick={() => { setQuery(''); }} className="text-xs text-gray-400 hover:text-red-500">✕ 清除</button>
        </div>
      )}

      {/* ── 技能列表 ── */}
      {loading ? (
        <div className="text-center py-24 text-gray-500">{t('skills.loading')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {skills.length === 0 && (
            <div className="col-span-full text-center py-12 text-gray-400">{t('skills.noSkills')}</div>
          )}
          {skills.map(skill => (
            <Link key={skill.id} href={`/skills/${skill.slug || skill.id}`} className="group p-6 border rounded-2xl hover:border-blue-500 transition-all hover:shadow-lg flex flex-col">
              <h3 className="text-xl font-bold mb-2 group-hover:text-blue-600">{skill.name}</h3>
              <p className="text-gray-600 text-sm mb-3 line-clamp-2">{skill.short_summary || skill.summary}</p>
              <div className="text-xs text-gray-400 mb-4">
                {skill.latest_version ? `v${skill.latest_version.version}` : '—'}
                {skill.updated_at && ` · ${new Date(skill.updated_at).toLocaleDateString()}`}
              </div>
              <div className="flex items-center justify-between pt-4 border-t mt-auto">
                <div className="flex items-center gap-2">
                  {skill.owner_user?.avatar_url ? (
                    <img src={skill.owner_user.avatar_url} alt={skill.owner_user?.name || ''} className="w-6 h-6 rounded-full object-cover" />
                  ) : (
                    <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center text-[10px] font-bold text-blue-600">{skill.owner_user?.name?.[0] || 'U'}</div>
                  )}
                  <span className="text-sm font-medium">{skill.owner_user?.name || 'Anonymous'}</span>
                </div>
                <div className="text-sm font-black text-blue-600">
                  {parseFloat(
                    sort === 'weekly' ? (skill.stats?.weekly_score || 0) : (skill.stats?.total_score || 0)
                  ).toFixed(1)} {t('skills.score')}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SkillSquare() {
  return (
    <Suspense fallback={<div className="text-center py-24 text-gray-500">加载中...</div>}>
      <SkillSquareInner />
    </Suspense>
  );
}
