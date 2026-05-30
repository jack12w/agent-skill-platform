'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useTranslation from '../../hooks/useTranslation';

interface Comment {
  id: string;
  content: string;
  created_at: string;
  user?: { id?: string; name?: string; avatar_url?: string | null };
}

/** 评论区 — 支持 listOnly / inputOnly 模式，供详情页左右分栏使用 */
export default function CommentSection({ skillId, skillSlug, listOnly, inputOnly, refreshKey, onCommentAdded, currentUserId }: {
  skillId: string;
  skillSlug: string;
  listOnly?: boolean;
  inputOnly?: boolean;
  refreshKey?: number;
  onCommentAdded?: () => void;
  currentUserId?: string | null;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadComments = async () => {
    try {
      const res = await fetch(`/api/skills/${skillSlug}/comments`);
      if (res.ok) setComments(await res.json());
    } catch {}
    finally { setLoading(false); }
  };

  useEffect(() => { loadComments(); }, [skillSlug, refreshKey]);

  const handleSubmit = async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/auth'); return; }
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/skills/${skillId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: text.trim() }),
      });
      if (res.ok) {
        setText('');
        await loadComments();
        onCommentAdded?.();
      }
    } catch {}
    finally { setSubmitting(false); }
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm('确定删除这条评论吗？')) return;
    const token = localStorage.getItem('token');
    if (!token) { router.push('/auth'); return; }
    try {
      const res = await fetch(`/api/skills/${skillId}/comments/${commentId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) await loadComments();
    } catch {}
  };

  // ── 仅输入模式 ──
  if (inputOnly) {
    return (
      <div>
        <h3 className="text-sm font-bold mb-2 text-gray-500">{t('comments.title')}</h3>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('comments.placeholder')}
          rows={3}
          className="w-full p-2 border rounded-lg resize-none text-xs"
        />
        <button
          onClick={handleSubmit}
          disabled={submitting || !text.trim()}
          className="mt-2 w-full py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 text-xs"
        >
          {submitting ? t('comments.submitting') : t('comments.submit')}
        </button>
      </div>
    );
  }

  // ── 仅列表模式（或默认完整模式） ──
  return (
    <div className="mt-8">
      {!listOnly && (
        <>
          <h2 className="text-xl font-bold mb-4">{t('comments.title')}</h2>
          <div className="mb-6">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('comments.placeholder')}
              rows={3}
              className="w-full p-3 border rounded-lg resize-none text-sm"
            />
            <button
              onClick={handleSubmit}
              disabled={submitting || !text.trim()}
              className="mt-2 px-5 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 text-sm"
            >
              {submitting ? t('comments.submitting') : t('comments.submit')}
            </button>
          </div>
        </>
      )}

      {listOnly && <h3 className="text-sm font-bold mb-3 text-gray-500">{t('comments.title')}</h3>}

      {loading ? (
        <div className="text-center py-4 text-gray-400 text-sm">{t('skills.loading')}</div>
      ) : comments.length === 0 ? (
        <div className="text-center py-4 text-gray-400 text-sm">{t('comments.empty')}</div>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div key={c.id} className="p-3 border rounded-lg">
              <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 items-start">
                {/* 头像 - 跨2行 */}
                <div className="row-span-2 w-6 h-6 rounded-full overflow-hidden flex items-center justify-center text-xs font-bold text-blue-600 bg-blue-100">
                  {c.user?.avatar_url ? (
                    <img src={c.user.avatar_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    c.user?.name?.[0] || 'U'
                  )}
                </div>
                {/* 用户昵称 */}
                <span className="font-medium text-sm truncate">{c.user?.name || 'Anonymous'}</span>
                {/* 日期 */}
                <span className="text-xs text-gray-400 text-right">
                  {new Date(c.created_at).toLocaleDateString()}
                </span>
                {/* 评论内容 - 有删除按钮时只占1列，无按钮时跨2列 */}
                <p className={`text-sm text-gray-700 whitespace-pre-wrap ${currentUserId && c.user?.id === currentUserId ? '' : 'col-span-2'}`}>{c.content}</p>
                {/* 删除图标 */}
                {currentUserId && c.user?.id === currentUserId && (
                  <button onClick={() => handleDelete(c.id)} className="text-gray-400 hover:text-red-400 transition justify-self-end" title="删除">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
