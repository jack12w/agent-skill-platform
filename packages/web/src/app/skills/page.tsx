'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

function SkillSquareInner() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const searchParam = searchParams.get('query') || '';
  const tagParam = searchParams.get('tag') || '';
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('weekly');
  const [query, setQuery] = useState(searchParam);

  useEffect(() => {
    const controller = new AbortController();
    const fetchSkills = async () => {
      setLoading(true);
      try {
        let url = `/api/skills?sort=${sort}`;
        if (query) url += `&query=${encodeURIComponent(query)}`;
        if (tagParam) url += `&tag=${encodeURIComponent(tagParam)}`;
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json();
        const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : [];
        setSkills(list);
      } catch (e) { if ((e as Error).name !== 'AbortError') console.error(e); }
      finally { setLoading(false); }
    };
    fetchSkills();
    return () => controller.abort();
  }, [sort, query, tagParam]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-2xl sm:text-4xl font-bold">{t('skills.square')}</h1>
        <div className="flex gap-2 p-1 bg-gray-100 rounded-lg self-start sm:self-auto">
          <button onClick={() => setSort('weekly')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'weekly' ? 'bg-white shadow-sm' : ''}`}>{t('skills.weeklyHot')}</button>
          <button onClick={() => setSort('total')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'total' ? 'bg-white shadow-sm' : ''}`}>{t('skills.allTime')}</button>
          <button onClick={() => setSort('new')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${sort === 'new' ? 'bg-white shadow-sm' : ''}`}>{t('skills.newest')}</button>
        </div>
      </div>

      {query && (
        <div className="mb-6 flex items-center gap-2">
          <span className="text-sm text-gray-500">搜索：</span>
          <span className="px-3 py-1 bg-blue-50 text-blue-700 text-sm rounded-full">{query}</span>
          <button onClick={() => { setQuery(''); window.history.replaceState(null, '', '/skills'); }} className="text-xs text-gray-400 hover:text-red-500">✕ 清除</button>
        </div>
      )}

      {loading ? (
        <div className="text-center py-24 text-gray-500">{t('skills.loading')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {skills.length === 0 && !loading && (
            <div className="col-span-full text-center py-12 text-gray-400">{t('skills.noSkills')}</div>
          )}
          {skills.map(skill => (
            <Link key={skill.id} href={`/skills/${skill.slug || skill.id}`} className="group p-6 border rounded-2xl hover:border-blue-500 transition-all hover:shadow-lg flex flex-col">
              <h3 className="text-xl font-bold mb-2 group-hover:text-blue-600">{skill.name}</h3>
              <p className="text-gray-600 text-sm mb-3 line-clamp-2">{skill.short_summary || skill.summary}</p>
              <div className="flex gap-2 mb-4 flex-wrap">
                {(skill.tags ?? []).map((tag: string) => (
                  <button key={tag} onClick={(e) => { e.preventDefault(); setQuery(tag); window.history.replaceState(null, '', `/skills?tag=${encodeURIComponent(tag)}`); }} className="text-xs px-2 py-1 bg-gray-100 rounded text-gray-500 hover:bg-blue-50 hover:text-blue-600 cursor-pointer">{tag}</button>
                ))}
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
                <div className="text-sm font-black text-blue-600">{parseFloat(skill.stats?.total_score || 0).toFixed(1)} {t('skills.score')}</div>
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
