'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

export default function Leaderboard() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('personal');
  const [period, setPeriod] = useState('weekly');
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/leaderboard?type=${tab}&period=${period}`);
        const snapshot = await res.json();
        setData(snapshot?.data_json || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    fetchLeaderboard();
  }, [tab, period]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <h1 className="text-2xl sm:text-3xl font-bold mb-6 sm:mb-8">{t('leaderboard.title')}</h1>
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 mb-6 sm:mb-8">
        <div className="flex p-1 bg-neutral-100 rounded-lg self-start">
          <button onClick={() => setTab('personal')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${tab === 'personal' ? 'bg-white shadow-sm' : ''}`}>{t('leaderboard.personal')}</button>
          <button onClick={() => setTab('team')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${tab === 'team' ? 'bg-white shadow-sm' : ''}`}>{t('leaderboard.team')}</button>
        </div>
        <div className="flex p-1 bg-neutral-100 rounded-lg self-start sm:ml-auto">
          <button onClick={() => setPeriod('weekly')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${period === 'weekly' ? 'bg-white shadow-sm' : ''}`}>{t('leaderboard.weekly')}</button>
          <button onClick={() => setPeriod('all')} className={`px-3 sm:px-4 py-2 rounded-md text-sm ${period === 'all' ? 'bg-white shadow-sm' : ''}`}>{t('leaderboard.allTime')}</button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-neutral-500">{t('leaderboard.loading')}</div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
        <table className="w-full border-collapse table-fixed text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 px-1 w-[36px]">{t('leaderboard.rank')}</th>
              <th className="py-2 px-1 w-[60px]">{t('leaderboard.subject')}</th>
              <th className="py-2 px-1 text-right w-[48px]">{t('leaderboard.skills')}</th>
              <th className="py-2 px-1 text-right w-[40px]">{t('leaderboard.likes')}</th>
              <th className="py-2 px-1 text-right w-[40px]">{t('leaderboard.downloads')}</th>
              <th className="py-2 px-1 text-right w-[48px]">{t('leaderboard.totalScore')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item, i) => (
              <tr key={item.id} className="border-b hover:bg-neutral-100">
                <td className="py-2 px-1 font-bold text-neutral-400 text-left">{i + 1}</td>
                <td className="py-2 px-1 max-w-[60px] truncate">
                  <Link
                    href={tab === 'personal'
                      ? `/users/${encodeURIComponent(item.name)}`
                      : `/teams/${item.id}`}
                    className="text-brand-600 hover:underline"
                  >
                    {item.name.length > 30 ? item.name.slice(0, 30) + '...' : item.name}
                  </Link>
                </td>
                <td className="py-2 px-1 text-right">{item.skill_count}</td>
                <td className="py-2 px-1 text-right">{item.likes}</td>
                <td className="py-2 px-1 text-right">{item.downloads}</td>
                <td className="py-2 px-1 text-right font-bold text-brand-600">{parseFloat(item.score).toFixed(1)}</td>
              </tr>
            ))}
            {data.length === 0 && (
              <tr><td colSpan={6} className="py-12 text-center text-neutral-400">{t('leaderboard.noData')}</td></tr>
            )}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
