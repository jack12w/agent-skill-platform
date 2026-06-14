'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

function loadUser() {
  try { const data = localStorage.getItem('user'); return data ? JSON.parse(data) : null; }
  catch { return null; }
}

function getReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem('read_comment_ids');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function markRead(commentId: string) {
  const ids = getReadIds();
  ids.add(commentId);
  try { localStorage.setItem('read_comment_ids', JSON.stringify(Array.from(ids))); }
  catch { /* noop */ }
}

export default function NotificationBell() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [allComments, setAllComments] = useState<any[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(getReadIds());

  useEffect(() => { setMounted(true); }, []);

  const fetchNotifications = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      // Always fetch ALL comments from others (no since filter)
      const res = await fetch('/api/auth/unread-comments', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAllComments(data.comments ?? []);
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

  // Unread = comments not in readIds
  const unread = allComments.filter((c) => !readIds.has(c.id));
  const unreadCount = unread.length;

  const handleClickComment = (commentId: string) => {
    markRead(commentId);
    setReadIds(getReadIds());
  };

  if (!mounted || !loadUser()) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-full transition"
        title="评论通知"
      >
        <svg className="w-[20px] h-[20px] sm:w-[22px] sm:h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-danger-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none z-10 shadow">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} />
          <div
            className="fixed left-4 right-4 sm:left-auto sm:right-4 sm:w-[340px] top-14 z-[60] bg-white border rounded-xl shadow-xl max-h-[380px] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 text-sm font-medium text-neutral-700 border-b sticky top-0 bg-white rounded-t-xl z-10 flex items-center justify-between">
              <span>评论通知{unreadCount > 0 && <span className="ml-1 text-danger-500">({unreadCount})</span>}</span>
            </div>

            {/* Unread first, then read */}
            {[...unread, ...allComments.filter((c) => readIds.has(c.id))].length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-neutral-400">暂无评论</div>
            ) : (
              [...unread, ...allComments.filter((c) => readIds.has(c.id))].map((c: any) => {
                const isUnread = !readIds.has(c.id);
                return (
                  <Link
                    key={c.id}
                    href={`/skills/${c.skill_slug || c.id}`}
                    onClick={() => handleClickComment(c.id)}
                    className={`block px-4 py-2.5 transition border-b border-neutral-100 last:border-0 ${isUnread ? 'bg-brand-50/60 hover:bg-brand-100/60' : 'hover:bg-neutral-100'}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-400 to-accent-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">
                        {c.user_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-neutral-500">
                          <span className="font-medium text-neutral-700">{c.user_name}</span>
                          {' 评论了 '}
                          <span className="text-brand-600">{c.skill_name}</span>
                          {isUnread && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-brand-500 align-middle" />}
                        </div>
                        <div className="text-sm text-neutral-600 mt-0.5 line-clamp-2">{c.content}</div>
                        <div className="text-[10px] text-neutral-400 mt-1">
                          {new Date(c.created_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
