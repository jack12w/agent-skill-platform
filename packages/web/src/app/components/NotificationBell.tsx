'use client';

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

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

function getClearedIds(): Set<string> {
  try {
    const raw = localStorage.getItem('cleared_comment_ids');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function clearCommentIds(ids: string[]) {
  const set = getClearedIds();
  ids.forEach((id) => set.add(id));
  try { localStorage.setItem('cleared_comment_ids', JSON.stringify(Array.from(set))); }
  catch { /* noop */ }
}

function extractTargetName(title?: string): string {
  if (!title) return '';
  const oldMatch = title.match(/你订阅的\s+(.+?)\s+有/);
  if (oldMatch) return oldMatch[1].trim();
  const newMatch = title.match(/^(.+?)\s+发布了/);
  return newMatch ? newMatch[1].trim() : (title.split(' ')[0] || '');
}

function Avatar({ src, fallback }: { src?: string; fallback: ReactNode }) {
  const [error, setError] = useState(false);
  if (src && !error) {
    return (
      <img
        src={src}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setError(true)}
      />
    );
  }
  return <>{fallback}</>;
}

export default function NotificationBell() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [allComments, setAllComments] = useState<any[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(getReadIds());
  const [clearedIds, setClearedIds] = useState<Set<string>>(getClearedIds());
  const [notiItems, setNotiItems] = useState<any[]>([]);
  const [notiUnread, setNotiUnread] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

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

  // 订阅类站内通知
  const fetchSubNotifications = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const res = await fetch('/api/notifications', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setNotiItems(data.items ?? []);
        setNotiUnread(data.unread ?? 0);
      }
    } catch { /* ignore */ }
  }, []);

  // Poll every 60s, pause when tab hidden
  useEffect(() => {
    if (!loadUser()) return;
    fetchNotifications();
    fetchSubNotifications();
    const interval = setInterval(() => {
      if (!document.hidden && loadUser()) {
        fetchNotifications();
        fetchSubNotifications();
      }
    }, 60000);
    const onVisible = () => { if (loadUser()) { fetchNotifications(); fetchSubNotifications(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchNotifications, fetchSubNotifications]);

  // 点击面板外部自动关闭
  useEffect(() => {
    if (!open) return;
    const handle = (e: Event) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('touchstart', handle);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('touchstart', handle);
    };
  }, [open]);

  // 可见评论（排除已清空的）
  const visibleComments = allComments.filter((c) => !clearedIds.has(c.id));
  // 未读 = 可见且未读 + 订阅通知未读
  const unread = visibleComments.filter((c) => !readIds.has(c.id));
  const unreadCount = unread.length + notiUnread;

  // 清空评论通知：只隐藏当前已读的评论（未读保留）
  const clearComments = () => {
    const readVisible = visibleComments.filter((c) => readIds.has(c.id));
    if (readVisible.length === 0) return;
    clearCommentIds(readVisible.map((c) => c.id));
    setClearedIds(getClearedIds());
  };

  // 清空订阅通知：调用后端删除当前用户已读通知，保留未读
  const clearNotifications = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      await fetch('/api/notifications', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    } catch { /* ignore */ }
    // 后端已删已读，前端仅移除已读项，未读继续保留
    setNotiItems((items) => items.filter((it) => !it.read));
  };

  const handleClickComment = (commentId: string) => {
    markRead(commentId);
    setReadIds(getReadIds());
  };

  // 点击订阅通知中的技能链接：标记已读，铃铛关闭，链接由 Next Link 跳转
  const handleClickSkillLink = async (notificationId: string) => {
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: notificationId }),
      });
    } catch { /* ignore */ }
    setNotiItems((items) => items.map((it) => (it.id === notificationId ? { ...it, read: true } : it)));
    setNotiUnread((u) => Math.max(0, u - 1));
    setOpen(false);
  };

  // 点击旧订阅通知整行（无 payload 时）：标记已读并跳转
  const handleClickNotification = async (n: any) => {
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: n.id }),
      });
    } catch { /* ignore */ }
    setNotiItems((items) => items.map((it) => (it.id === n.id ? { ...it, read: true } : it)));
    setNotiUnread((u) => Math.max(0, u - 1));
    if (n.link) router.push(n.link);
    setOpen(false);
  };

  if (!mounted || !loadUser()) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-full transition"
        title="通知"
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
        <div
          ref={panelRef}
          className="fixed left-4 right-4 sm:left-auto sm:right-4 sm:w-[340px] top-14 z-[60] bg-white border border-neutral-200 rounded-xl shadow-xl h-[380px] flex flex-col overflow-hidden"
        >
          {/* 评论通知 */}
          <div className="h-[190px] flex flex-col min-h-0 overflow-hidden border-b border-neutral-200">
            <div className="px-4 py-2.5 text-sm font-semibold text-neutral-800 bg-neutral-50 border-b border-neutral-200 z-10 flex items-center justify-between shrink-0">
              <span>评论通知{unread.length > 0 && <span className="ml-1 text-danger-500">({unread.length})</span>}</span>
              {visibleComments.some((c) => readIds.has(c.id)) && (
                <button onClick={clearComments} className="text-xs font-normal text-neutral-400 hover:text-danger-500 transition">清空</button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {visibleComments.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-neutral-400">暂无评论</div>
              ) : (
                [...unread, ...visibleComments.filter((c) => readIds.has(c.id))].map((c: any) => {
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
          </div>

          {/* 订阅通知 */}
          <div className="h-[190px] flex flex-col min-h-0 overflow-hidden">
            <div className="px-4 py-2.5 text-sm font-semibold text-neutral-800 bg-neutral-50 border-b border-neutral-200 z-10 flex items-center justify-between shrink-0">
              <span>订阅通知{notiUnread > 0 && <span className="ml-1 text-danger-500">({notiUnread})</span>}</span>
              {notiItems.some((n) => n.read) && (
                <button onClick={clearNotifications} className="text-xs font-normal text-neutral-400 hover:text-danger-500 transition">清空</button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {notiItems.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-neutral-400">暂无订阅</div>
              ) : (
                notiItems.map((n: any) => {
                  const skills = n.payload?.skills ?? [];
                  const targetAvatar = n.payload?.targetAvatar;
                  const targetName = n.payload?.targetName || extractTargetName(n.title) || '';
                  const fallbackLetter = targetName.charAt(0).toUpperCase();
                  return (
                    <div
                      key={n.id}
                      className={`w-full px-4 py-2.5 transition border-b border-neutral-100 last:border-0 ${n.read ? '' : 'bg-brand-50/60 hover:bg-brand-100/60'} hover:bg-neutral-100`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-400 to-accent-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5 overflow-hidden">
                          <Avatar
                            src={targetAvatar}
                            fallback={
                              fallbackLetter || (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                              )
                            }
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-neutral-500">
                            <span className="font-medium text-neutral-700">{n.title}</span>
                            {!n.read && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-brand-500 align-middle" />}
                          </div>
                          {skills.length > 0 ? (
                            <div className="mt-1 space-y-1">
                              {skills.map((s: any, idx: number) => (
                                <Link
                                  key={s.id || idx}
                                  href={s.link}
                                  onClick={() => handleClickSkillLink(n.id)}
                                  className="block text-sm text-brand-600 hover:text-brand-700 hover:underline line-clamp-1"
                                >
                                  {s.name}
                                  <span
                                    className={`ml-1.5 inline-block px-1.5 py-0.5 text-[10px] rounded ${
                                      s.subtype === 'new_version' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'
                                    }`}
                                  >
                                    {s.subtype === 'new_version' ? '新版本' : '新技能'}
                                  </span>
                                </Link>
                              ))}
                            </div>
                          ) : (
                            <button
                              onClick={() => handleClickNotification(n)}
                              className="w-full text-left"
                            >
                              <div className="text-sm text-neutral-600 mt-0.5 line-clamp-2 whitespace-pre-line">{n.body}</div>
                            </button>
                          )}
                          <div className="text-[10px] text-neutral-400 mt-1">
                            {new Date(n.created_at).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
