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

interface Analytics {
  totalPV: number; todayPV: number; uv7d: number;
  trends: { date: string; count: number; uv: number }[];
  topPages: { path: string; count: number }[];
}

function getToken() {
  try { return localStorage.getItem('token'); } catch { return null; }
}

export default function HubPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const analyticsChartRef = useRef<HTMLCanvasElement>(null);
  const analyticsChartInstRef = useRef<any>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => { if (!res.ok) throw new Error('Forbidden'); return res.json(); })
      .then(data => { setStats(data); })
      .catch(err => { setError(err.message); });

    fetch('/api/admin/analytics', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => { setAnalytics(data); setLoading(false); })
      .catch(() => { setLoading(false); });
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
            { label: t('detail.likes') || 'Likes', data: likes, borderColor: '#3366FF', backgroundColor: 'rgba(51,102,255,0.1)', fill: true, tension: 0.3 },
            { label: t('detail.downloads') || 'Downloads', data: downloads, borderColor: '#10B981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3 },
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

  // Analytics chart
  useEffect(() => {
    if (!analytics?.trends?.length) return;
    const Chart = (window as any).Chart;
    if (!Chart || !analyticsChartRef.current) return;
    if (analyticsChartInstRef.current) analyticsChartInstRef.current.destroy();

    const labels = analytics.trends.map(d => d.date.slice(5));
    analyticsChartInstRef.current = new Chart(analyticsChartRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'PV', data: analytics.trends.map(d => Number(d.count) || 0), borderColor: '#8B5CF6', backgroundColor: 'rgba(139,92,246,0.1)', fill: true, tension: 0.3 },
          { label: 'UV', data: analytics.trends.map(d => Number(d.uv) || 0), borderColor: '#F59E0B', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' as const } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      },
    });
  }, [analytics]);

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;
  if (error) return <div className="flex items-center justify-center h-64"><p className="text-red-500 text-sm">{error}</p></div>;

  const cards = [
    { label: t('admin.skills'), value: `${stats?.skills.published ?? '-'} / ${stats?.skills.total ?? '-'}`, sub: t('admin.published'), color: 'brand' as const },
    { label: t('admin.users'), value: stats?.users.total ?? '-', sub: `${t('admin.published')} 7d: ${stats?.users.last7d ?? 0}`, color: 'green' as const },
    { label: t('admin.teams'), value: stats?.teams.total ?? '-', color: 'accent' as const },
    { label: t('admin.comments'), value: stats?.comments.total ?? '-', color: 'amber' as const },
  ];

  const cm: Record<string, string> = { brand: 'bg-brand-50 border-brand-200', green: 'bg-green-50 border-green-200', accent: 'bg-accent-50 border-accent-200', amber: 'bg-amber-50 border-amber-200' };
  const ct: Record<string, string> = { brand: 'text-brand-700', green: 'text-green-700', accent: 'text-accent-700', amber: 'text-amber-700' };

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-1">{t('admin.stats')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('admin.overview')}</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map(card => (
          <div key={card.color} className={`${cm[card.color]} glass border rounded-xl p-4`}>
            <p className={`text-3xl font-bold ${ct[card.color]}`}>{card.value}</p>
            <p className="text-sm text-neutral-600 mt-1">{card.label}</p>
            {card.sub && <p className="text-xs text-neutral-400 mt-0.5">{card.sub}</p>}
          </div>
        ))}
      </div>

      {/* Chart */}
      {stats && stats.trends.length > 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-8">
          <h2 className="text-sm font-semibold text-neutral-700 mb-4">{t('admin.overview')}</h2>
          <div style={{ height: 240 }}><canvas ref={chartRef} /></div>
        </div>
      )}

      {stats && stats.topSkills.length > 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-neutral-700 mb-3">Top 10</h2>
          <div className="space-y-1">
            {stats.topSkills.map((s, i) => (
              <a key={s.id} href={`/skills/${s.slug}`} target="_blank" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-neutral-100 transition-colors">
                <span className="w-6 h-6 rounded-full bg-neutral-100 text-xs font-medium text-neutral-500 flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-sm text-neutral-800 flex-1 truncate">{s.name}</span>
                <span className="text-xs text-neutral-400">{Number(s.score).toFixed(1)}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Analytics section */}
      {analytics && (
        <>
          <h2 className="text-sm font-semibold text-neutral-700 mb-3 mt-8">{t('admin.websiteAnalytics')}</h2>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-accent-50 border border-accent-200 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-accent-700">{analytics.totalPV.toLocaleString()}</p>
              <p className="text-xs text-accent-500">{t('admin.totalPV')}</p>
            </div>
            <div className="bg-accent-50 border border-accent-200 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-accent-700">{analytics.todayPV}</p>
              <p className="text-xs text-accent-500">{t('admin.todayPV')}</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-amber-700">{analytics.uv7d.toLocaleString()}</p>
              <p className="text-xs text-amber-500">{t('admin.sevenDayUV')}</p>
            </div>
          </div>

          {analytics.trends.length > 0 && (
            <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-4">
              <h2 className="text-sm font-semibold text-neutral-700 mb-3">{t('admin.pvUvTrend')}</h2>
              <div style={{ height: 200 }}><canvas ref={analyticsChartRef} /></div>
            </div>
          )}

          {analytics.topPages.length > 0 && (
            <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-4">
              <h2 className="text-sm font-semibold text-neutral-700 mb-3">{t('admin.topPages')}</h2>
              <div className="space-y-1">
                {analytics.topPages.map((p: any) => (
                  <div key={p.path} className="flex items-center justify-between px-3 py-1.5 rounded hover:bg-neutral-100">
                    <span className="text-sm text-neutral-700 truncate">{p.path}</span>
                    <span className="text-xs text-neutral-400 shrink-0 ml-4">{p.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
