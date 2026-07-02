'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../../hooks/useTranslation';
import SkillUpdateBadge from '../../components/SkillUpdateBadge';

export default function TeamShowcase({ params }: { params: { id: string } }) {
  const { t } = useTranslation();
  const [team, setTeam] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);

  const load = async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/teams/${params.id}`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setTeam(data);
      setIsOwner(data.is_owner);
    } catch (e: any) {
      setError(e.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [params.id]);

  // 页面获得焦点时刷新数据（从技能编辑页返回后）
  useEffect(() => {
    const handleFocus = () => { load(); };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [params.id]);

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
        <h1 className="text-2xl font-bold mb-2">{t('team.cannotLoad')}</h1>
        <p className="text-neutral-500 mb-6">{error}</p>
        <Link href="/skills" className="text-brand-600 underline">
          {t('skills.square')}
        </Link>
      </div>
    );
  }

  if (!team) return null;

  const skills = team.skills ?? [];
  const members = team.members ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Team header */}
      <div className="mb-10">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-neutral-900">{team.name}</h1>
            {team.description && (
              <p className="text-lg text-neutral-600 mt-3 max-w-2xl">{team.description}</p>
            )}
            <div className="flex items-center gap-4 mt-4 text-sm text-neutral-500">
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                {members.length} {t('team.members')}
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
                {skills.length} {t('team.teamSkills')}
              </span>
            </div>
          </div>
          {isOwner && (
            <Link
              href={`/teams/${params.id}/settings`}
              className="inline-flex items-center gap-2 px-4 py-2 border border-neutral-300 rounded-lg text-sm font-medium text-neutral-700 hover:bg-neutral-100 transition shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {t('team.manage')}
            </Link>
          )}
        </div>
      </div>

      {/* Members section */}
      <section className="mb-10">
        <h2 className="text-xl font-bold mb-4 text-neutral-900">{t('team.members')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {members.map((m: any) => (
            <div key={m.user_id} className="flex items-center gap-3 p-3 border rounded-lg">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-400 to-accent-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
                {m.user?.avatar_url ? (
                  <img src={m.user.avatar_url} alt={m.user?.name} className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  (m.user?.name || '?').charAt(0).toUpperCase()
                )}
              </div>
              <div className="min-w-0">
                <div className="font-medium text-neutral-900 truncate">{m.user?.name || 'Unknown'}</div>
                <span className="text-xs text-neutral-500 capitalize">{m.role}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Skills section */}
      <section>
        <h2 className="text-xl font-bold mb-4 text-neutral-900">{t('team.teamSkills')} ({skills.length})</h2>
        {skills.length === 0 ? (
          <div className="p-8 border border-dashed rounded-xl text-center text-neutral-400">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            <p>{t('team.noSkills')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {skills.map((s: any) => (
              <Link
                key={s.id}
                href={`/skills/${s.slug || s.id}`}
                className="block p-5 border rounded-xl hover:border-brand-300 hover:shadow-sm hover:bg-brand-50/30 transition group glass"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-neutral-900 group-hover:text-brand-600 transition-colors">{s.name}</h3>
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
                    {s.stats?.likes_total ?? 0}
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="#5C85FF" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    {s.stats?.downloads_total ?? 0}
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
      </section>
    </div>
  );
}
