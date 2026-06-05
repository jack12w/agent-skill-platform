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

function getLastCheck(): string | null {
  try { return localStorage.getItem('last_comment_check'); }
  catch { return null; }
}

function setLastCheck(ts: string) {
  try { localStorage.setItem('last_comment_check', ts); }
  catch { /* noop */ }
}

export default function AvatarMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const [user, setUser] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [recentComments, setRecentComments] = useState<any[]>([]);

  const refreshUser = useCallback(() => setUser(loadUser()), []);

  const fetchNotifications = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const since = getLastCheck();
      const params = since ? `?since=${encodeURIComponent(since)}` : '';
      const res = await fetch(`/api/auth/unread-comments${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUnread(data.count ?? 0);
        setRecentComments(data.comments ?? []);
      }
    } catch { /* ignore fetch errors */ }
  }, []);

  useEffect(() => { refreshUser(); }, [pathname, refreshUser]);

  // Auto-fetch on mount and every 60s (pause when tab is hidden)
  useEffect(() => {
    if (!loadUser()) return;
    fetchNotifications();

    const interval = setInterval(() => {
      if (!document.hidden && loadUser()) fetchNotifications();
    }, 60000);

    const onVisible = () => {
      if (loadUser()) fetchNotifications();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchNotifications]);

  // Listen for user-updated events
  useEffect(() => {
    const handler = () => refreshUser();
    window.addEventListener('user-updated', handler);
    return () => window.removeEventListener('user-updated', handler);
  }, [refreshUser]);

  const handleOpen = () => {
    setOpen(!open);
    if (!open) {
      // Mark as read: set last check to now
      setLastCheck(new Date().toISOString());
      setUnread(0);
      // Refresh to get latest
      fetchNotifications();
    }
  };

  if (!user) {
    return <Link href="/auth" className="px-4 py-2 border border-blue-600 text-blue-600 rounded-md hover:bg-blue-50 text-sm font-medium">{t('nav.login')}</Link>;
  }

  const initial = (user.name || user.email || 'U')[0].toUpperCase();

  return (
    <div className="relative">
      <button
        onClick={handleOpen}
        className="relative w-[25px] h-[25px] sm:w-[30px] sm:h-[30px] rounded-full flex items-center justify-center text-sm font-bold overflow-hidden hover:ring-2 hover:ring-blue-300 transition"
        title={user.name || user.email}
      >
        {user.avatar_url ? (
          <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full bg-blue-600 text-white flex items-center justify-center">{initial}</span>
        )}
        {/* Unread badge */}
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-[18px] h-[18px] sm:w-[20px] sm:h-[20px] bg-red-500 text-white text-[10px] sm:text-xs font-bold rounded-full flex items-center justify-center leading-none shadow-sm">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-20 bg-white border rounded-lg shadow-lg py-1 min-w-[200px] sm:min-w-[220px]">
            <div className="px-4 py-2 text-sm text-gray-500 border-b">{user.name || user.email}</div>
            <Link href="/dashboard" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-gray-50">{t('avatar.dashboard')}</Link>

            {/* Recent comments */}
            {recentComments.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-xs text-gray-400 border-t">最新评论</div>
                {recentComments.slice(0, 3).map((c: any) => (
                  <Link
                    key={c.id}
                    href={`/skills/${c.skill_slug || c.id}`}
                    onClick={() => setOpen(false)}
                    className="block px-4 py-2 text-sm hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 shrink-0">
                        {c.user_name.charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs text-gray-700 truncate">
                          <span className="font-medium">{c.user_name}</span>
                          <span className="text-gray-400 mx-1">·</span>
                          <span className="text-gray-500">{c.skill_name}</span>
                        </div>
                        <div className="text-xs text-gray-400 truncate">{c.content}</div>
                      </div>
                    </div>
                  </Link>
                ))}
              </>
            )}
            <button onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('user'); setOpen(false); setUser(null); router.push('/'); }} className="block w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-gray-50 border-t">
              {t('avatar.logout')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
