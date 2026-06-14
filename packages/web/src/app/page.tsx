'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../hooks/useTranslation';

export default function Home() {
  const { t } = useTranslation();
  const [trending, setTrending] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [skillsRes, lbRes] = await Promise.all([
          fetch('/api/skills?sort=total&size=10'),
          fetch('/api/leaderboard?type=personal&period=all'),
        ]);
        if (skillsRes.ok) {
          const data = await skillsRes.json();
          setTrending(Array.isArray(data) ? data.slice(0, 10) : (data?.items?.slice(0, 10) ?? []));
        }
        if (lbRes.ok) {
          const snap = await lbRes.json();
          setLeaderboard((snap?.data_json ?? []).slice(0, 10));
        }
      } catch {}
    };
    fetchData();
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <section className="text-center mb-16">
        <h1 className="text-3xl sm:text-5xl font-extrabold mb-4">{t('home.title')}</h1>
        <p className="text-lg sm:text-xl text-neutral-600 mb-6 sm:mb-8 px-2">{t('home.subtitle')}</p>
        <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4">
          <Link href="/skills" className="px-8 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700">{t('home.explore')}</Link>
          <Link href="/leaderboard" className="px-8 py-3 border rounded-lg font-medium hover:bg-neutral-100">{t('home.viewLeaderboard')}</Link>
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-12">
        <section>
          <h2 className="text-2xl font-bold mb-6">{t('home.trending')}</h2>
          <div className="space-y-4">
            {trending.length === 0 && <p className="text-sm text-neutral-400">{t('home.noSkills')}</p>}
            {trending.map((skill) => (
              <Link key={skill.id} href={`/skills/${skill.slug || skill.id}`} className="block p-4 border rounded-lg hover:border-brand-300 hover:bg-brand-50/30 transition min-h-[5rem]">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-bold">{skill.name}</h3>
                    <p className="text-sm text-neutral-500 truncate max-w-[160px] sm:max-w-[320px]">{skill.short_summary || skill.summary}</p>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <span className="text-brand-600 font-bold">{parseFloat(skill.stats?.total_score || 0).toFixed(1)} {t('home.score')}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-6">{t('home.hotLeaderboard')}</h2>
          <div className="space-y-4">
            {leaderboard.length === 0 && <p className="text-sm text-neutral-400">{t('home.noData')}</p>}
            {leaderboard.map((item, i) => (
              <div key={item.id} className="p-4 bg-neutral-100 rounded-lg flex items-center gap-4 min-h-[5rem]">
                <span className="text-2xl font-bold text-neutral-300">#{i + 1}</span>
                <div className="flex-1">
                  <Link href={`/users/${encodeURIComponent(item.name)}`} className="font-bold text-brand-600 hover:underline">{item.name}</Link>
                  <p className="text-sm text-neutral-500 truncate">{item.skill_count} {t('home.skills')} · {item.likes} ♥ · {item.downloads} ↓</p>
                </div>
                <span className="font-bold text-brand-600">{parseFloat(item.score).toFixed(1)} {t('home.score')}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
