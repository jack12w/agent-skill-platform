'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

const AVATAR_GRADIENT = 'linear-gradient(135deg, #7C3AED, #06B6D4)';

const MEDALS: Record<number, { bg: string; text: string; size: string; num: string }> = {
  1: { bg: 'linear-gradient(135deg, #FFD56B, #F59E0B)', text: 'text-white', size: 'w-14 h-14', num: 'text-xl' },
  2: { bg: 'linear-gradient(135deg, #E5E9F0, #94A3B8)', text: 'text-slate-700', size: 'w-12 h-12', num: 'text-lg' },
  3: { bg: 'linear-gradient(135deg, #F5C28D, #C0713B)', text: 'text-white', size: 'w-12 h-12', num: 'text-lg' },
};

function Crown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-9 h-7 drop-shadow">
      <path d="M3 7l4 5 5-7 5 7 4-5v10H3V7z" fill="#F59E0B" />
      <path d="M3 17h18" stroke="#D97706" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function Leaderboard() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'personal' | 'team'>('personal');
  const [period, setPeriod] = useState<'weekly' | 'all'>('weekly');
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

  const isTeam = tab === 'team';
  const isWeekly = period === 'weekly';

  const podium = data.slice(0, 3);
  const list = data.slice(3);

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-[#F7F5FF] to-[#FAFAFA]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs font-semibold tracking-[0.2em] uppercase text-brand-600">
            {isTeam ? t('leaderboard.eyebrowTeam') : t('leaderboard.eyebrowPersonal')}
          </p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-gradient-brand">{t('leaderboard.title')}</h1>
          <p className="mt-2 text-sm text-neutral-500">{t('leaderboard.subtitle')}</p>
        </div>

        {/* Tabs */}
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 mb-8">
          <div className="flex p-1 bg-neutral-100/70 backdrop-blur-sm rounded-xl self-start">
            {(['personal', 'team'] as const).map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-medium transition ${
                  tab === key ? 'bg-white shadow-sm text-brand-700' : 'text-neutral-500 hover:text-neutral-700'
                }`}
              >
                {t(`leaderboard.${key}`)}
              </button>
            ))}
          </div>
          <div className="flex p-1 bg-neutral-100/70 backdrop-blur-sm rounded-xl self-start sm:ml-auto">
            {(['weekly', 'all'] as const).map((key) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-medium transition ${
                  period === key ? 'bg-white shadow-sm text-brand-700' : 'text-neutral-500 hover:text-neutral-700'
                }`}
              >
                {key === 'weekly' ? t('leaderboard.weekly') : t('leaderboard.allTime')}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-center py-20 text-neutral-500">{t('leaderboard.loading')}</div>
        ) : data.length === 0 ? (
          <div className="text-center py-20 text-neutral-400">{t('leaderboard.noData')}</div>
        ) : (
          <>
            {/* Podium */}
            <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-end sm:justify-center">
              {podium.map((item, i) => {
                const rank = i + 1;
                const medal = MEDALS[rank];
                const isChampion = rank === 1;
                const orderClass = rank === 1 ? 'sm:order-2' : rank === 2 ? 'sm:order-1' : 'sm:order-3';
                const widthClass = isChampion ? 'sm:w-[320px]' : 'sm:w-[300px]';
                return (
                  <div
                    key={item.id}
                    className={`relative flex flex-col items-center gap-2.5 rounded-2xl bg-white px-6 py-6 border border-brand-100 shadow-lg
                      ${orderClass} ${widthClass}
                      ${isChampion ? 'sm:pb-9 sm:pt-8 shadow-[0_12px_34px_rgba(124,58,237,0.25)]' : ''}`}
                  >
                    {isChampion && (
                      <div className="absolute -top-5">
                        <Crown />
                      </div>
                    )}
                    <div
                      className={`flex items-center justify-center ${medal.size} rounded-full font-bold ${medal.text}`}
                      style={{ background: medal.bg }}
                    >
                      {rank}
                    </div>
                    <div
                      className={`flex items-center justify-center rounded-full text-white font-bold ${
                        isChampion ? 'w-[68px] h-[68px] text-2xl' : 'w-16 h-16 text-xl'
                      }`}
                      style={{ background: AVATAR_GRADIENT }}
                    >
                      {item.name?.charAt(0) || '?'}
                    </div>
                    <div className="text-lg font-bold text-neutral-900">{item.name}</div>
                    {isTeam && (
                      <span className="px-2.5 py-1 rounded-full bg-brand-50 text-brand-700 text-xs font-medium">
                        {isWeekly
                          ? t('leaderboard.newMembers', { n: item.new_members })
                          : t('leaderboard.memberTotal', { n: item.member_count })}
                      </span>
                    )}
                    <div className="text-sm text-neutral-500 text-center">
                      {item.skill_count} {t('leaderboard.skills')} · {item.likes} {t('leaderboard.likes')} ·{' '}
                      {item.downloads} {t('leaderboard.downloads')}
                    </div>
                    <div className="mt-1 text-3xl font-bold text-brand-700">{Number(item.score).toFixed(1)}</div>
                    <div className="text-xs text-neutral-400">{t('leaderboard.scoreLabel')}</div>
                  </div>
                );
              })}
            </div>

            {/* Full list */}
            {list.length > 0 && (
              <div className="mt-8 rounded-2xl bg-white border border-neutral-200 shadow-md overflow-hidden">
                <div className="flex items-center justify-between px-4 py-4 border-b border-neutral-100">
                  <span className="text-base font-bold text-neutral-900">{t('leaderboard.fullBoard')}</span>
                  <span className="text-xs text-neutral-400">{t('leaderboard.scoreLabel')}</span>
                </div>
                {list.map((item, i) => {
                  const rank = i + 4;
                  const meta = isTeam
                    ? isWeekly
                      ? `${t('leaderboard.newMembers', { n: item.new_members })} · ${item.skill_count} ${t('leaderboard.skills')}`
                      : `${item.member_count} ${t('leaderboard.members')} · ${item.skill_count} ${t('leaderboard.skills')}`
                    : `${t('leaderboard.creator')} · ${item.skill_count} ${t('leaderboard.skills')}`;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-4 px-4 py-3.5 border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition"
                    >
                      <div className="w-6 text-center font-semibold text-neutral-400">{rank}</div>
                      <div
                        className="flex items-center justify-center w-10 h-10 rounded-full text-white text-sm font-bold shrink-0"
                        style={{ background: AVATAR_GRADIENT }}
                      >
                        {item.name?.charAt(0) || '?'}
                      </div>
                      <Link
                        href={isTeam ? `/teams/${item.id}` : `/users/${encodeURIComponent(item.name)}`}
                        className="min-w-0 flex-1"
                      >
                        <div className="font-bold text-neutral-900 truncate">{item.name}</div>
                        <div className="text-xs text-neutral-400 truncate">{meta}</div>
                      </Link>
                      <div className="font-bold text-brand-700">{Number(item.score).toFixed(1)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
