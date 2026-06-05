'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

function loadUser() {
  try {
    const data = localStorage.getItem('user');
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export default function AvatarMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const [user, setUser] = useState<any>(null);
  const [open, setOpen] = useState(false);

  const refreshUser = useCallback(() => setUser(loadUser()), []);

  useEffect(() => { refreshUser(); }, [pathname, refreshUser]);

  useEffect(() => {
    const handler = () => refreshUser();
    window.addEventListener('user-updated', handler);
    return () => window.removeEventListener('user-updated', handler);
  }, [refreshUser]);

  if (!user) {
    return <Link href="/auth" className="px-4 py-2 border border-blue-600 text-blue-600 rounded-md hover:bg-blue-50 text-sm font-medium">{t('nav.login')}</Link>;
  }

  const initial = (user.name || user.email || 'U')[0].toUpperCase();

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="w-[25px] h-[25px] sm:w-[30px] sm:h-[30px] rounded-full flex items-center justify-center text-sm font-bold overflow-hidden hover:ring-2 hover:ring-blue-300 transition" title={user.name || user.email}>
        {user.avatar_url ? (
          <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full bg-blue-600 text-white flex items-center justify-center">{initial}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-20 bg-white border rounded-lg shadow-lg py-1 min-w-[140px]">
            <div className="px-4 py-2 text-sm text-gray-500 border-b">{user.name || user.email}</div>
            <Link href="/dashboard" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-gray-50">{t('avatar.dashboard')}</Link>
            <button onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('user'); setOpen(false); setUser(null); router.push('/'); }} className="block w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-gray-50">{t('avatar.logout')}</button>
          </div>
        </>
      )}
    </div>
  );
}
