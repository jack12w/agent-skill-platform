'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import MDEditor from '@uiw/react-md-editor';
import useTranslation from '../../../hooks/useTranslation';
import CommentSection from '../../components/CommentSection';

function decodeUserId(): string | null {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload?.sub ?? null;
  } catch { return null; }
}

export default function SkillDetail({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const { t } = useTranslation();
  const [skill, setSkill] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [commentRefresh, setCommentRefresh] = useState(0);

  useEffect(() => { setCurrentUserId(decodeUserId()); }, []);
  const loadVersions = async (skillId: string) => { const res = await fetch(`/api/skills/${skillId}/versions`); if (res.ok) setVersions(await res.json()); };
  const reload = async () => { const res = await fetch(`/api/skills/${params.slug}`); if (res.ok) { const data = await res.json(); setSkill(data); await loadVersions(data.id); } };

  useEffect(() => {
    (async () => {
      try { const res = await fetch(`/api/skills/${params.slug}`); if (!res.ok) throw new Error(`HTTP ${res.status}`); const data = await res.json(); setSkill(data); await loadVersions(data.id); }
      catch (e: any) { setError(e.message || 'Failed to load skill'); }
      finally { setLoading(false); }
    })();
  }, [params.slug]);

  const handleLike = async () => {
    if (!skill) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { alert(t('detail.loginFirst')); router.push('/auth'); return; }
    setActing('like');
    try {
      const res = await fetch(`/api/skills/${skill.id}/like`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { alert(t('detail.loginExpired')); router.push('/auth'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await reload();
    } catch (e: any) { alert(t('detail.likeFailed') + ': ' + (e.message || 'unknown error')); }
    finally { setActing(null); }
  };

  const handleDownload = (versionId?: string) => {
    if (!skill) return;
    const key = versionId ? `dl:${versionId}` : 'download';
    setActing(key);
    const url = versionId ? `/api/skills/${skill.id}/versions/${versionId}/download/file` : `/api/skills/${skill.id}/download/file`;
    const a = document.createElement('a'); a.href = url; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { setActing(null); reload(); }, 800);
  };

  if (loading) return <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center text-gray-500">{t('skills.loading')}</div>;
  if (error || !skill) return (<div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center"><h1 className="text-2xl font-bold mb-2">{t('detail.skillNotFound')}</h1><p className="text-gray-500">{error}</p></div>);

  const tags: string[] = skill.tags ?? [];
  const ownerName = skill.owner_user?.name || 'Anonymous';
  const isOwner = !!currentUserId && currentUserId === skill.owner_user_id;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex flex-col md:flex-row gap-12">
        <div className="flex-1 min-w-0 md:min-w-[460px]">
          <div className="flex items-start justify-between gap-4 mb-4"><h1 className="text-2xl sm:text-4xl font-bold">{skill.name}</h1>{isOwner && <Link href={`/skills/${skill.slug || skill.id}/edit`} className="shrink-0 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">{t('detail.edit')}</Link>}</div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">{tags.map((tag) => (
            <button key={tag} onClick={() => router.push(`/skills?tag=${encodeURIComponent(tag)}`)} className="px-3 py-1 bg-blue-50 text-blue-600 text-sm rounded-full hover:bg-blue-100 hover:text-blue-700 transition cursor-pointer">
              {tag}
            </button>
          ))}</div>
          {skill.content_md && (
            <div data-color-mode="light" className="mb-6 p-5 border rounded-xl bg-white max-h-[288px] md:max-h-[388px] overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' as any }}>
              <MDEditor.Markdown source={skill.content_md} />
            </div>
          )}
          {skill.io_schema && (<div className="p-6 bg-gray-50 rounded-xl mb-8"><h2 className="text-xl font-bold mb-4">{t('detail.ioSchema')}</h2><pre className="text-sm bg-gray-100 p-4 rounded overflow-auto">{JSON.stringify(skill.io_schema, null, 2)}</pre></div>)}
          <div className="p-6 border rounded-xl">
            <h2 className="text-xl font-bold mb-4">{t('detail.versionHistory')}</h2>
            {versions.length === 0 ? (<p className="text-sm text-gray-500">{t('detail.noVersion')}</p>) : (
              <div className="space-y-2">{versions.map((v) => { const isLatest = skill.latest_version_id === v.id; const downloading = acting === `dl:${v.id}`; return (<div key={v.id} className="p-3 bg-gray-50 rounded-lg"><div className="flex items-center justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono font-medium">v{v.version}</span>{isLatest && <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">{t('detail.latest')}</span>}</div><div className="text-xs text-gray-500 mt-0.5">{v.size ? `${(v.size / 1024).toFixed(1)} KB · ` : ''}{new Date(v.created_at).toLocaleString()}</div></div><button onClick={() => handleDownload(v.id)} disabled={acting !== null} className="shrink-0 text-sm px-3 py-1.5 border border-blue-600 text-blue-600 rounded hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">{downloading ? t('detail.downloading') : t('detail.download')}</button></div>{v.notes && <p className="text-xs text-gray-500 mt-1 ml-1">{v.notes}</p>}</div>); })}</div>
            )}
          </div>

          {/* ── 评论列表（左栏内） ── */}
          <CommentSection skillId={skill.id} skillSlug={params.slug} listOnly refreshKey={commentRefresh} currentUserId={currentUserId} />
        </div>
        <div className="w-full md:w-80 space-y-6">
          <div className="p-6 border rounded-xl">
            <div className="text-center mb-6"><span className="text-sm text-gray-500">{t('detail.skillScore')}</span><div className="text-3xl sm:text-4xl font-black text-blue-600">{parseFloat(skill.stats?.total_score || 0).toFixed(1)}</div></div>
            <div className="grid grid-cols-2 gap-4 text-center mb-6"><div className="p-3 bg-gray-50 rounded-lg"><div className="font-bold">{skill.stats?.likes_total || 0}</div><div className="text-xs text-gray-500">{t('detail.likes')}</div></div><div className="p-3 bg-gray-50 rounded-lg"><div className="font-bold">{skill.stats?.downloads_total || 0}</div><div className="text-xs text-gray-500">{t('detail.downloads')}</div></div></div>
            <button onClick={() => handleDownload()} disabled={acting !== null || versions.length === 0} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 mb-3 disabled:opacity-50 disabled:cursor-not-allowed">{acting === 'download' ? t('detail.downloading') : versions.length === 0 ? t('detail.noVersionYet') : `${t('detail.download')} v${versions.find((v) => v.id === skill.latest_version_id)?.version || versions[0]?.version || 'latest'}`}</button>
            <button onClick={handleLike} disabled={acting !== null} className="w-full py-3 border border-blue-600 text-blue-600 rounded-lg font-bold hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">{acting === 'like' ? t('detail.liking') : t('detail.likeSkill')}</button>
          </div>
          <div className="text-sm text-gray-500"><div>{t('detail.publishedBy')}: <Link href={`/users/${encodeURIComponent(ownerName)}`} className="text-blue-600 font-medium hover:underline">{ownerName}</Link></div>{skill.owner_team && <div>{t('detail.teamLabel')}: <Link href={`/teams/${skill.owner_team.id}`} className="text-blue-600 font-medium hover:underline">{skill.owner_team.name}</Link></div>}<div>{t('detail.lastUpdated')}: <span className="text-gray-900 font-medium">{skill.updated_at ? new Date(skill.updated_at).toLocaleDateString() : '-'}</span></div></div>

          {/* ── 评论输入（右侧） ── */}
          <div className="p-4 border rounded-xl bg-white">
            <CommentSection skillId={skill.id} skillSlug={params.slug} inputOnly onCommentAdded={() => setCommentRefresh((c) => c + 1)} />
          </div>
        </div>
      </div>
    </div>
  );
}
