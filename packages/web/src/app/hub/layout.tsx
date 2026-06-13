'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

interface AdminUser { sub: string; email: string; role: string }

function decodeToken(): AdminUser | null {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
}

const MENU = [
  { key: 'stats',     label: 'admin.stats',       icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { key: 'reviews',   label: 'admin.reviews',      icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
  { key: 'users',     label: 'admin.users',        icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z' },
  { key: 'skills',    label: 'admin.skills',       icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
  { key: 'tags',      label: 'admin.tags',         icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z' },
  { key: 'tag-groups', label: 'admin.tagGroups',     icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
  { key: 'comments',  label: 'admin.comments',     icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  { key: 'teams',     label: 'admin.teams',        icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
  { key: 'logs',      label: 'admin.logs',         icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
  { key: 'settings',  label: 'admin.settings',     icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

export default function HubLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const user = decodeToken();
    if (!user || user.role !== 'admin') {
      router.replace('/');
      return;
    }
    setAuthorized(true);
    setLoaded(true);
  }, [router]);

  if (!loaded) return null;
  if (!authorized) return null;

  const activeKey = pathname === '/hub' ? 'stats' : pathname.split('/hub/')[1]?.split('/')[0] || 'stats';

  return (
    <>
      <style>{`body { overflow: hidden; } footer { display: none !important; }`}</style>
      <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 shrink-0 hidden md:flex md:flex-col h-full">
        <div className="px-5 py-5 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-semibold text-gray-900">SkillHub</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t('admin.title')}</p>
        </div>
        <nav className="py-2 overflow-y-auto flex-1">
          {MENU.map(item => (
            <Link
              key={item.key}
              href={item.key === 'stats' ? '/hub' : `/hub/${item.key}`}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                activeKey === item.key
                  ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
              </svg>
              {t(item.label)}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-0 left-0 w-56 p-4 border-t border-gray-100">
          <Link href="/" className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {t('admin.backToSite')}
          </Link>
        </div>
      </aside>

      {/* Mobile nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40 flex overflow-x-auto">
        {MENU.map(item => (
          <Link
            key={item.key}
            href={item.key === 'stats' ? '/hub' : `/hub/${item.key}`}
            className={`flex flex-col items-center justify-center min-w-[64px] py-2 px-1 text-[10px] ${
              activeKey === item.key ? 'text-blue-600' : 'text-gray-400'
            }`}
          >
            <svg className="w-5 h-5 mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
            </svg>
            {t(item.label)}
          </Link>
        ))}
      </div>

      {/* Content */}
      <main className="flex-1 bg-gray-50 p-4 md:p-6 pb-20 md:pb-6 overflow-auto">
        {children}
      </main>
    </div>
    </>
  );
}
