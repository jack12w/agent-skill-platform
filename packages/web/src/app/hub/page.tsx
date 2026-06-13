'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

interface Stats {
  skills: { total: number; published: number };
  users: { total: number };
  teams: { total: number };
  comments: { total: number };
}

function getToken() {
  try { return localStorage.getItem('token'); } catch { return null; }
}

export default function HubPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch('/api/admin/stats', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => { if (!res.ok) throw new Error('Forbidden'); return res.json(); })
      .then(data => { setStats(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-red-500 text-sm">{error}</p>
      </div>
    );
  }

  const cards = [
    { label: t('admin.skills'), value: stats?.skills.total ?? '-', sub: `${t('admin.published')}: ${stats?.skills.published ?? '-'}`, href: '/hub/skills', color: 'blue' },
    { label: t('admin.users'), value: stats?.users.total ?? '-', sub: '', href: '/hub/users', color: 'green' },
    { label: t('admin.teams'), value: stats?.teams.total ?? '-', sub: '', href: '/hub/teams', color: 'purple' },
    { label: t('admin.comments'), value: stats?.comments.total ?? '-', sub: '', href: '/hub/comments', color: 'amber' },
  ];

  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    blue:   { bg: 'bg-blue-50',   text: 'text-blue-700',   border: 'border-blue-200' },
    green:  { bg: 'bg-green-50',  text: 'text-green-700',  border: 'border-green-200' },
    purple: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
    amber:  { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-200' },
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{t('admin.stats')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('admin.overview')}</p>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map(card => {
          const c = colorMap[card.color];
          return (
            <Link
              key={card.color}
              href={card.href}
              className={`${c.bg} ${c.border} border rounded-xl p-4 hover:shadow-sm transition-shadow`}
            >
              <p className={`text-3xl font-bold ${c.text}`}>{card.value}</p>
              <p className="text-sm text-gray-600 mt-1">{card.label}</p>
              {card.sub && <p className="text-xs text-gray-400 mt-0.5">{card.sub}</p>}
            </Link>
          );
        })}
      </div>

      {/* Quick actions */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">{t('admin.quickActions')}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Link href="/hub/tags" className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 hover:border-blue-300 hover:text-blue-700 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          {t('admin.manageTags')}
        </Link>
        <Link href="/submit" className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 hover:border-blue-300 hover:text-blue-700 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          {t('admin.uploadSkill')}
        </Link>
      </div>
    </div>
  );
}
