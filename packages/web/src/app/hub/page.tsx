'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

interface Stats {
  skills: { total: number; published: number };
  users: { total: number; last7d: number };
  teams: { total: number };
  comments: { total: number };
  trends: { date: string; likes: number; downloads: number }[];
  topSkills: { id: string; name: string; slug: string; tags: string[]; score: number }[];
}

function getToken() {
  try { return localStorage.getItem('token'); } catch { return null; }
}

export default function HubPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstanceRef = useRef<any>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => { if (!res.ok) throw new Error('Forbidden'); return res.json(); })
      .then(data => { setStats(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  // Render chart when stats load
  useEffect(() => {
    if (!stats?.trends?.length) return;

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
    script.onload = () => {
      const Chart = (window as any).Chart;
      if (!Chart || !chartRef.current) return;

      if (chartInstanceRef.current) chartInstanceRef.current.destroy();

      const labels = stats.trends.map(d => d.date.slice(5)); // MM-DD
      const likes = stats.trends.map(d => Number(d.likes) || 0);
      const downloads = stats.trends.map(d => Number(d.downloads) || 0);

      chartInstanceRef.current = new Chart(chartRef.current, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: t('detail.likes') || 'Likes', data: likes, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
            { label: t('detail.downloads') || 'Downloads', data: downloads, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true, position: 'bottom' as const } },
          scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
      });
    };
    document.head.appendChild(script);

    return () => { if (script.parentNode) script.parentNode.removeChild(script); };
  }, [stats, t]);

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  if (error) return <div className="flex items-center justify-center h-64"><p className="text-red-500 text-sm">{error}</p></div>;

  const cards = [
    { label: t('admin.skills'), value: `${stats?.skills.published ?? '-'} / ${stats?.skills.total ?? '-'}`, sub: t('admin.published'), color: 'blue' as const },
    { label: t('admin.users'), value: stats?.users.total ?? '-', sub: `${t('admin.published')} 7d: ${stats?.users.last7d ?? 0}`, color: 'green' as const },
    { label: t('admin.teams'), value: stats?.teams.total ?? '-', color: 'purple' as const },
    { label: t('admin.comments'), value: stats?.comments.total ?? '-', color: 'amber' as const },
  ];

  const cm: Record<string, string> = { blue: 'bg-blue-50 border-blue-200', green: 'bg-green-50 border-green-200', purple: 'bg-purple-50 border-purple-200', amber: 'bg-amber-50 border-amber-200' };
  const ct: Record<string, string> = { blue: 'text-blue-700', green: 'text-green-700', purple: 'text-purple-700', amber: 'text-amber-700' };

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{t('admin.stats')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('admin.overview')}</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map(card => (
          <div key={card.color} className={`${cm[card.color]} border rounded-xl p-4`}>
            <p className={`text-3xl font-bold ${ct[card.color]}`}>{card.value}</p>
            <p className="text-sm text-gray-600 mt-1">{card.label}</p>
            {card.sub && <p className="text-xs text-gray-400 mt-0.5">{card.sub}</p>}
          </div>
        ))}
      </div>

      {/* Chart */}
      {stats && stats.trends.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-8">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">{t('admin.overview')}</h2>
          <div style={{ height: 240 }}><canvas ref={chartRef} /></div>
        </div>
      )}

      {/* Top 10 */}
      {stats && stats.topSkills.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Top 10</h2>
          <div className="space-y-1">
            {stats.topSkills.map((s, i) => (
              <a key={s.id} href={`/skills/${s.slug}`} target="_blank" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors">
                <span className="w-6 h-6 rounded-full bg-gray-100 text-xs font-medium text-gray-500 flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-sm text-gray-800 flex-1 truncate">{s.name}</span>
                <span className="text-xs text-gray-400">{Number(s.score).toFixed(1)}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
