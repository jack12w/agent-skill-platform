'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import useTranslation from '../../../hooks/useTranslation';
import SkillUpdateBadge from '../../components/SkillUpdateBadge';

export default function UserProfile({ params }: { params: { username: string } }) {
  const { t } = useTranslation();
  // params.username may or may not be URL-decoded depending on Next.js version / middleware.
  // Normalize: try to decode first, fall back to raw value.
  const username = (() => {
    try { return decodeURIComponent(params.username); }
    catch { return params.username; }
  })();
  const [user, setUser] = useState<any>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── 订阅相关 ──
  const [subscriberCount, setSubscriberCount] = useState(0);
  const [subscribed, setSubscribed] = useState(false);
  const [subLoading, setSubLoading] = useState(false);
  const currentUserId = (() => {
    try { const u = JSON.parse(localStorage.getItem('user') || 'null'); return u?.id || null; } catch { return null; }
  })();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = skills.length < total && total > 0;

  const load = useCallback(async (pageNum: number = 1, append: boolean = false) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const [userRes, skillsRes] = await Promise.all([
        fetch(`/api/users/${encodeURIComponent(username)}`),
        fetch(`/api/users/${encodeURIComponent(username)}/skills?page=${pageNum}&size=20`, { headers }),
      ]);

      if (!userRes.ok) {
        const body = await userRes.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${userRes.status}`);
      }

      const userData = await userRes.json();
      setUser(userData);

      // 订阅数 + 当前用户订阅状态
      try {
        const countRes = await fetch(`/api/subscriptions/count?targetType=user&targetId=${encodeURIComponent(userData.id)}`);
        if (countRes.ok) {
          const c = await countRes.json();
          setSubscriberCount(c.count ?? 0);
        }
      } catch { /* ignore */ }
      if (currentUserId && currentUserId !== userData.id) {
        try {
          const stRes = await fetch(`/api/subscriptions/status?targetType=user&targetId=${encodeURIComponent(userData.id)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (stRes.ok) {
            const st = await stRes.json();
            setSubscribed(!!st.subscribed);
          }
        } catch { /* ignore */ }
      }

      if (skillsRes.ok) {
        const skillsData = await skillsRes.json();
        setSkills(prev => append ? [...prev, ...(skillsData.items ?? [])] : (skillsData.items ?? []));
        setTotal(skillsData.total ?? 0);
        setPage(pageNum);
      }
    } catch (e: any) {
      if (!append) setError(e.message || 'Load failed');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [username]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await load(page + 1, true);
  }, [loadingMore, hasMore, page, load]);

  // Initial load
  useEffect(() => { setLoading(true); setActiveTag(null); load(); }, [load]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const toggleSubscribe = async () => {
    if (!currentUserId || !user) return;
    setSubLoading(true);
    try {
      const token = localStorage.getItem('token') || '';
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (subscribed) {
        const res = await fetch(`/api/subscriptions?targetType=user&targetId=${encodeURIComponent(user.id)}`, { method: 'DELETE', headers });
        if (res.ok) { setSubscribed(false); setSubscriberCount((c) => Math.max(0, c - 1)); }
      } else {
        const res = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetType: 'user', targetId: user.id }),
        });
        if (res.ok) { setSubscribed(true); setSubscriberCount((c) => c + 1); }
      }
    } catch { /* ignore */ }
    finally { setSubLoading(false); }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 text-center text-neutral-500">
        {t('skills.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 text-center">
        <h1 className="text-2xl font-bold mb-2">User not found</h1>
        <p className="text-neutral-500 mb-6">{error}</p>
        <Link href="/skills" className="text-brand-600 underline">
          {t('skills.square')}
        </Link>
      </div>
    );
  }

  if (!user) return null;

  const displayedSkills = activeTag
    ? skills.filter((s: any) => (s.tags ?? []).includes(activeTag))
    : skills;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Profile header */}
      <div className="mb-10">
        <div className="flex items-start gap-4 sm:gap-6">
          {/* Avatar */}
          <div className="w-16 h-16 sm:w-24 sm:h-24 rounded-full bg-gradient-to-br from-brand-400 to-accent-500 flex items-center justify-center text-white text-2xl sm:text-3xl font-bold shrink-0 overflow-hidden">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
            ) : (
              (user.name || '?').charAt(0).toUpperCase()
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-4xl font-bold text-neutral-900 truncate">{user.name}</h1>
            {user.bio && (
              <p className="text-neutral-600 mt-1 max-w-2xl text-sm sm:text-base">{user.bio}</p>
            )}

            {/* Stats */}
            <div className="flex flex-wrap items-center gap-4 sm:gap-6 mt-3">
              <div className="flex items-center gap-1.5">
                <span className="text-xl sm:text-2xl font-bold text-neutral-900">{user.skill_count}</span>
                <span className="text-xs sm:text-sm text-neutral-500">{t('home.skills')}</span>
              </div>
              <div className="w-px h-6 sm:h-8 bg-neutral-200" />
              <div className="flex items-center gap-1.5">
                <svg className="w-4 h-4 sm:w-5 sm:h-5 text-red-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
                <span className="text-xl sm:text-2xl font-bold text-neutral-900">{user.total_likes}</span>
                <span className="text-xs sm:text-sm text-neutral-500">{t('detail.likes')}</span>
              </div>
              <div className="w-px h-6 sm:h-8 bg-neutral-200" />
              <div className="flex items-center gap-1.5">
                <svg className="w-4 h-4 sm:w-5 sm:h-5 text-brand-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                <span className="text-xl sm:text-2xl font-bold text-neutral-900">{user.total_downloads}</span>
                <span className="text-xs sm:text-sm text-neutral-500">{t('detail.downloads')}</span>
              </div>
            </div>

            {/* Subscribe row */}
            {currentUserId && currentUserId !== user.id ? (
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={toggleSubscribe}
                  disabled={subLoading}
                  className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition ${subscribed ? 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200' : 'bg-brand-600 text-white hover:bg-brand-700'}`}
                >
                  {subscribed ? (
                    <>
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
                      已订阅
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
                      订阅
                    </>
                  )}
                </button>
                <span className="text-sm text-neutral-500">{subscriberCount} 人订阅</span>
              </div>
            ) : (
              <div className="mt-3 text-sm text-neutral-500">{subscriberCount} 人订阅</div>
            )}
          </div>
        </div>
      </div>

      {/* Tag TAB filter */}
      {user.tags && user.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <button
            onClick={() => setActiveTag(null)}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${activeTag === null ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-neutral-600 border-neutral-300 hover:border-brand-300'}`}
          >
            全部
          </button>
          {user.tags.map((tag: string) => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${activeTag === tag ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-neutral-600 border-neutral-300 hover:border-brand-300'}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Skills section */}
      <section>
        <h2 className="text-xl font-bold mb-4 text-neutral-900">
          {t('dashboard.mySkills')} ({activeTag ? displayedSkills.length : total})
        </h2>
        {displayedSkills.length === 0 ? (
          <div className="p-8 border border-dashed rounded-xl text-center text-neutral-400">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            <p>{activeTag ? '该标签下暂无技能' : t('dashboard.noSkills')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {displayedSkills.map((s: any) => (
              <Link
                key={s.id}
                href={`/skills/${s.slug || s.id}`}
                className="block p-5 border rounded-xl hover:border-brand-300 hover:shadow-sm hover:bg-brand-50/30 transition group"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-neutral-900 group-hover:text-brand-600 transition-colors">
                    {s.name}
                  </h3>
                  <SkillUpdateBadge hasUpdate={!!s.has_update} />
                </div>
                {s.short_summary && (
                  <p className="text-sm text-neutral-500 mt-1 line-clamp-2">{s.short_summary}</p>
                )}
                {s.tags && s.tags.length > 0 && (() => {
                  const tags = s.tags || [];
                  const featured = tags.filter((t: string) => t === '精选');
                  const others = tags.filter((t: string) => t !== '精选');
                  const display = [...featured, ...others].slice(0, 4);
                  const hidden = tags.length - display.length;
                  return (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {display.map((tag: string) => (
                        <span key={tag} className={`text-xs px-2 py-0.5 rounded-full ${tag === '精选' ? 'bg-orange-50 text-orange-800 border border-orange-200' : 'bg-neutral-100 text-neutral-600'}`}>
                          {tag}
                        </span>
                      ))}
                      {hidden > 0 && (
                        <span className="text-xs text-neutral-400">+{hidden}</span>
                      )}
                    </div>
                  );
                })()}
                <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-neutral-100 text-xs text-neutral-400">
                  <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="#F43F5E">
                      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                    </svg>
                    {s.likes_total}
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="#5C85FF" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    {s.downloads_total}
                  </span>
                  </div>
                  <span className="text-right shrink-0">
                    {s.latest_version ? `v${s.latest_version.version}` : '—'}
                    {s.updated_at && ` · ${new Date(s.updated_at).toLocaleDateString()}`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
        {hasMore && (
          <div ref={sentinelRef} className="mt-6 py-4 text-center text-sm text-neutral-400">
            {loadingMore ? t('skills.loading') : `${skills.length} / ${total}`}
          </div>
        )}
      </section>
    </div>
  );
}
