'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';
import { fetchTagGroups } from '../../lib/tag-groups';
import SkillUpdateBadge from '../components/SkillUpdateBadge';

/* ── 预设标签分组 ── */
const FALLBACK_TAG_GROUPS: Record<string, string[]> = {
  source: ['精选', '社区'],
  scene: ['workbuddy', 'accio work', '阿里国际站', '国际站生意助手'],
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
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sort, setSort] = useState('weekly');
  const [query, setQuery] = useState(searchParam);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set(tagsParam ? tagsParam.split(',').filter(Boolean) : []));
  const [tagGroups, setTagGroups] = useState(FALLBACK_TAG_GROUPS);

  useEffect(() => { fetchTagGroups().then(g => { if (Object.keys(g).length) setTagGroups(g); }); }, []);

  const activeTagsStr = Array.from(activeTags).join(',');

  const fetchSkills = useCallback(async (pageNum: number, append: boolean) => {
    const controller = new AbortController();
    if (pageNum === 1) setLoading(true);
    else setLoadingMore(true);
    try {
      let url = `/api/skills?sort=${sort}&page=${pageNum}&size=20`;
      if (query) url += `&query=${encodeURIComponent(query)}`;
      if (activeTags.size > 0) url += `&tags=${encodeURIComponent(activeTagsStr)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: typeof window !== 'undefined' && localStorage.getItem('token')
          ? { Authorization: `Bearer ${localStorage.getItem('token')}` }
          : {},
      });
      const data = await res.json();
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : [];
      if (append) setSkills(prev => [...prev, ...list]);
      else setSkills(list);
      setHasMore(list.length >= 20);
    } catch (e) { if ((e as Error).name !== 'AbortError') console.error(e); }
    finally { setLoading(false); setLoadingMore(false); }
    return controller;
  }, [sort, query, activeTagsStr]);

  // Initial load + reset on filter change
  useEffect(() => {
    setPage(1);
    const ctrl = fetchSkills(1, false);
    return () => { ctrl.then(c => c.abort()); };
  }, [fetchSkills]);

  // Load more
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    const next = page + 1;
    setPage(next);
    fetchSkills(next, true);
  }, [page, loadingMore, hasMore, fetchSkills]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadMore();
    }, { rootMargin: '200px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, skills.length]);

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
    for (const [group, tags] of Object.entries(tagGroups)) {
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
          (tagGroups[group] || []).forEach(t => next.delete(t));
        }
        next.add(tag);
      }
      return next;
    });
  };

  const clearGroup = (group: string) => {
    const groupTags = tagGroups[group] || [];
    setActiveTags(prev => {
      const next = new Set(prev);
      groupTags.forEach(t => next.delete(t));
      return next;
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* ── Hero 引导区 ── */}
      <div className="mb-8 p-6 sm:p-10 bg-gradient-to-r from-brand-50 via-white to-amber-50 border border-brand-100 rounded-2xl text-center">
        <h2 className="text-xl sm:text-2xl font-bold text-neutral-900 mb-2">{t('skills.heroTitle')}</h2>
        <p className="text-sm sm:text-base text-neutral-500 mb-5 max-w-xl mx-auto">{t('skills.heroDesc')}</p>
        <div className="flex justify-center gap-3">
          <Link href="/submit" className="px-6 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-bold hover:bg-brand-700 transition">
            {t('skills.heroSubmit')}
          </Link>
          <button onClick={() => { document.getElementById('skills-list')?.scrollIntoView({ behavior: 'smooth' }); }} className="px-6 py-2.5 border border-brand-300 text-brand-600 rounded-lg text-sm font-medium hover:bg-brand-50 transition">
            {t('skills.heroExplore')}
          </button>
        </div>
      </div>

      {/* ── 标题 + 排序 ── */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-2xl sm:text-4xl font-bold">{t('skills.square')}</h1>
        <div className="flex gap-2 p-1 bg-neutral-100 rounded-lg self-start sm:self-auto">
          <button onClick={() => setSort('weekly')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'weekly' ? 'bg-white shadow-sm' : ''}`}>{t('skills.weeklyHot')}</button>
          <button onClick={() => setSort('total')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'total' ? 'bg-white shadow-sm' : ''}`}>{t('skills.allTime')}</button>
          <button onClick={() => setSort('new')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'new' ? 'bg-white shadow-sm' : ''}`}>{t('skills.newest')}</button>
        </div>
      </div>

      {/* ── 分类筛选 ── */}
      <div className="mb-6 space-y-3">
        {GROUP_KEYS.map(group => {
          const tags = tagGroups[group];
          const allKey = group === 'source' ? 'allSource' : group === 'scene' ? 'allScene' : group === 'role' ? 'allRole' : 'allCategory';
          const hasActive = tags.some(t => activeTags.has(t));
          return (
            <div key={group} className="flex gap-1.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' as any, msOverflowStyle: 'none' }}>
              <button
                onClick={() => clearGroup(group)}
                className={`shrink-0 px-3 py-1.5 text-sm rounded-full whitespace-nowrap transition ${!hasActive ? 'bg-brand-600 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}
              >
                {t(`tags.${allKey}`)}
              </button>
              {tags.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`shrink-0 px-3 py-1.5 text-sm rounded-full whitespace-nowrap transition ${activeTags.has(tag) ? 'bg-brand-600 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}
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
          <span className="text-sm text-neutral-500">搜索：</span>
          <span className="px-3 py-1 bg-brand-50 text-brand-700 text-sm rounded-full">{query}</span>
          <button onClick={() => { setQuery(''); }} className="text-xs text-neutral-400 hover:text-danger-500">✕ 清除</button>
        </div>
      )}

      {/* ── 技能列表 ── */}
      {loading ? (
        <div className="text-center py-24 text-neutral-500">{t('skills.loading')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {skills.length === 0 && (
            <div className="col-span-full text-center py-12 text-neutral-400">{t('skills.noSkills')}</div>
          )}
          {skills.map(skill => (
            <Link key={skill.id} href={`/skills/${skill.slug || skill.id}`} className="group p-6 border rounded-2xl hover:border-brand-500 transition-all hover:shadow-lg flex flex-col glass">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xl font-bold group-hover:text-brand-600">{skill.name}</h3>
                <SkillUpdateBadge hasUpdate={!!skill.has_update} />
              </div>
              <p className="text-neutral-600 text-sm mb-3 line-clamp-2">{skill.short_summary || skill.summary}</p>
              <div className="text-xs text-neutral-400 mb-4">
                {skill.latest_version ? `v${skill.latest_version.version}` : '—'}
                {skill.updated_at && ` · ${new Date(skill.updated_at).toLocaleDateString()}`}
              </div>
              <div className="flex items-center justify-between pt-4 border-t mt-auto">
                <div className="flex items-center gap-2">
                  {skill.owner_user?.avatar_url ? (
                    <img src={skill.owner_user.avatar_url} alt={skill.owner_user?.name || ''} className="w-6 h-6 rounded-full object-cover" />
                  ) : (
                    <div className="w-6 h-6 bg-brand-100 rounded-full flex items-center justify-center text-[10px] font-bold text-brand-600">{skill.owner_user?.name?.[0] || 'U'}</div>
                  )}
                  <span className="text-sm font-medium">{skill.owner_user?.name || 'Anonymous'}</span>
                </div>
                <div className="text-sm font-black text-brand-600">
                  {parseFloat(
                    sort === 'weekly' ? (skill.stats?.weekly_score || 0) : (skill.stats?.total_score || 0)
                  ).toFixed(1)} {t('skills.score')}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {/* Infinite scroll sentinel */}
      <div id="scroll-sentinel" className="h-1" />
      {loadingMore && (
        <div className="text-center py-8 text-neutral-400 text-sm">加载更多技能...</div>
      )}
      {!hasMore && skills.length > 0 && (
        <div className="text-center py-8 text-neutral-300 text-xs">— 已加载全部技能 —</div>
      )}
    </div>
  );
}

export default function SkillSquare() {
  return (
    <Suspense fallback={<div className="text-center py-24 text-neutral-500">加载中...</div>}>
      <SkillSquareInner />
    </Suspense>
  );
}
