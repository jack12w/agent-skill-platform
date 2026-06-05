'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

function loadUser() {
  try { const data = localStorage.getItem('user'); return data ? JSON.parse(data) : null; }
  catch { return null; }
}

function getLastCheck(): string | null {
  try { return localStorage.getItem('last_comment_check'); }
  catch { return null; }
}

function setLastCheck(ts: string) {
  try { localStorage.setItem('last_comment_check', ts); }
  catch { /* noop */ }
}

export default function NotificationBell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [comments, setComments] = useState<any[]>([]);

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
        setComments(data.comments ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  // Poll every 60s, pause when tab hidden
  useEffect(() => {
    if (!loadUser()) return;
    fetchNotifications();
    const interval = setInterval(() => {
      if (!document.hidden && loadUser()) fetchNotifications();
    }, 60000);
    const onVisible = () => { if (loadUser()) fetchNotifications(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchNotifications]);

  const handleBellClick = () => {
    if (!open) {
      setLastCheck(new Date().toISOString());
      setUnread(0);
      fetchNotifications();
    }
    setOpen(!open);
  };

  if (!loadUser()) return null;

  return (
    <div className="relative">
      <button
        onClick={handleBellClick}
        className="relative p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-full transition"
        title="评论通知"
      >
        {/* Bell icon */}
        <svg className="w-[20px] h-[20px] sm:w-[22px] sm:h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {/* Red badge */}
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none z-10 shadow">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-40 bg-white border rounded-xl shadow-xl py-2 w-[300px] sm:w-[340px] max-h-[360px] overflow-y-auto">
            <div className="px-4 py-2 text-sm font-medium text-gray-700 border-b">评论通知</div>
            {comments.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">暂无新评论</div>
            ) : (
              comments.map((c: any) => (
                <Link
                  key={c.id}
                  href={`/skills/${c.skill_slug || c.id}`}
                  onClick={() => setOpen(false)}
                  className="block px-4 py-2.5 hover:bg-gray-50 transition border-b border-gray-50 last:border-0"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">
                      {c.user_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-gray-500">
                        <span className="font-medium text-gray-700">{c.user_name}</span>
                        {' 评论了 '}
                        <span className="text-blue-600">{c.skill_name}</span>
                      </div>
                      <div className="text-sm text-gray-600 mt-0.5 line-clamp-2">{c.content}</div>
                      <div className="text-[10px] text-gray-400 mt-1">
                        {new Date(c.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
