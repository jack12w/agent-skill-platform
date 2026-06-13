'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import MDEditor from '@uiw/react-md-editor';
import useTranslation from '../../../../hooks/useTranslation';
import { fetchTagGroups } from '../../../../lib/tag-groups';

/* ── 预设标签分组（不含来源，来源=社区默认且不可更改） ── */
const FALLBACK_PRESET_TAGS: Record<string, string[]> = {
  scene: ['workbuddy', 'accio work', '阿里国际站', '国际站生意助手'],
  role: ['老板', '管理', '运营', '业务', '美工', '市场', '采购', '供应链', '社媒'],
  category: ['选品洞察', 'Listing优化', '广告投放', '客户服务', '数据分析', '社媒营销', '供应链物流', '合规风控'],
};
const GROUP_KEYS = ['scene', 'role', 'category'] as const;

function decodeUserId(): string | null {
  try { const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null; if (!token) return null; return JSON.parse(atob(token.split('.')[1]))?.sub ?? null; }
  catch { return null; }
}

export default function EditSkill({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const { t, tt } = useTranslation();
  const [skill, setSkill] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagGroups, setTagGroups] = useState(FALLBACK_PRESET_TAGS);

  useEffect(() => { fetchTagGroups().then(g => { const filtered: Record<string, string[]> = {}; for (const k of GROUP_KEYS) if (g[k]) filtered[k] = g[k]; if (Object.keys(filtered).length) setTagGroups(filtered); }); }, []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [versionNotes, setVersionNotes] = useState('');
  const [form, setForm] = useState({ name: '', content_md: '', tags: '', cover_url: '', owner_team_id: '' });
  const [myTeams, setMyTeams] = useState<any[]>([]);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { router.push('/auth'); return; }
    const load = async () => {
      try {
        const [sRes, vRes, tRes] = await Promise.all([fetch(`/api/skills/${params.slug}`), fetch(`/api/skills/${params.slug}/versions`), fetch('/api/teams/my', { headers: { Authorization: `Bearer ${token}` } })]);
        if (!sRes.ok) throw new Error(`HTTP ${sRes.status}`);
        const s = await sRes.json(); const uid = decodeUserId();
        if (s.owner_user_id !== uid) { setError('You are not the owner of this skill.'); setSkill(s); return; }
        setSkill(s); setForm({ name: s.name ?? '', content_md: s.content_md ?? '', tags: (s.tags ?? []).filter((t: string) => t !== '社区').join(', '), cover_url: s.cover_url ?? '', owner_team_id: s.owner_team_id ?? '' });
        if (vRes.ok) setVersions(await vRes.json());
        if (tRes.ok) setMyTeams(await tRes.json());
      } catch (e: any) { setError(e.message || 'Load failed'); }
      finally { setLoading(false); }
    }; load();
  }, [params.slug, router]);

  const onChange = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /* 追加标签到输入框（去重） */
  const addTag = (tag: string) => {
    setForm(prev => {
      const current = prev.tags.split(/[,，]/).map(x => x.trim()).filter(Boolean);
      if (current.includes(tag)) return prev;
      return { ...prev, tags: [...current, tag].join(', ') };
    });
  };

  const handleSave = async (e: React.FormEvent) => { e.preventDefault(); if (!skill) return; const token = localStorage.getItem('token'); if (!token) return router.push('/auth'); setSaving(true);
    try {
      const payload = { name: form.name.trim(), content_md: form.content_md, cover_url: form.cover_url, tags: ['社区', ...form.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean)], owner_team_id: form.owner_team_id || null };
      const res = await fetch(`/api/skills/${skill.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      router.push(`/skills/${skill.slug || skill.id}`);
    } catch (err: any) { alert(t('edit.saveFailed') + ': ' + err.message); }
    finally { setSaving(false); }
  };

  const handleDeleteVersion = async (vid: string, vname: string) => { if (!skill) return; if (!confirm(t('edit.deleteVersionConfirm').replace('{version}', vname))) return; const token = localStorage.getItem('token'); if (!token) return router.push('/auth');
    try {
      const res = await fetch(`/api/skills/${skill.id}/versions/${vid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      const vRes = await fetch(`/api/skills/${skill.id}/versions`); if (vRes.ok) setVersions(await vRes.json());
    } catch (err: any) { alert(t('edit.deleteFailed') + ': ' + err.message); }
  };

  const handleUpload = async () => { if (!skill || !fileRef.current?.files?.[0]) return; const token = localStorage.getItem('token'); if (!token) return router.push('/auth'); setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', fileRef.current.files[0]);
      const n = versionNotes.trim(); if (n) fd.append('notes', n);
      const res = await fetch(`/api/skills/${skill.id}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      const vRes = await fetch(`/api/skills/${skill.id}/versions`); if (vRes.ok) setVersions(await vRes.json());
      if (fileRef.current) fileRef.current.value = ''; setVersionNotes(''); alert(t('edit.newVersionUploaded'));
    } catch (err: any) { alert(t('edit.uploadFailed') + ': ' + err.message); }
    finally { setUploading(false); }
  };

  if (loading) return <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center text-gray-500">{t('skills.loading')}</div>;
  if (error) return (<div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center"><h1 className="text-2xl font-bold mb-2">Cannot edit</h1><p className="text-gray-500 mb-6">{error}</p>{skill && <Link href={`/skills/${skill.slug || skill.id}`} className="text-blue-600 underline">Back to skill</Link>}</div>);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center gap-2 sm:gap-0 mb-6 sm:mb-8">
        <Link href={`/skills/${skill.slug || skill.id}`} className="shrink-0 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
          <svg className="w-5 h-5" viewBox="0 0 1024 1024" fill="currentColor"><path d="M277.818 543.962l401.629 384.163c18.504 17.681 48.475 17.68 66.947 0s18.474-46.361 0-64.043L378.2 511.953l368.194-352.155c18.474-17.68 18.474-46.331 0-64.012-18.474-17.682-48.444-17.682-66.947 0L277.818 479.949c-18.504 17.652-18.504 46.331 0 64.012z"/></svg>
          <span className="hidden sm:inline">{t('edit.back')}</span>
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold flex-1 text-center">{t('edit.title')}</h1>
        <div className="w-5 sm:w-16 shrink-0" />
      </div>

      {/* ── 上传新版本（置顶） ── */}
      <div className="mb-8 p-5 sm:p-6 border-2 border-dashed rounded-xl bg-blue-50/30 border-blue-300">
        <h2 className="text-lg font-bold mb-3">{t('edit.uploadVersion')}</h2>
        <p className="text-xs text-gray-500 mb-3">{t('edit.uploadHint')}（{t('edit.uploadLimitHint', { limit: 300 })}）</p>
        <textarea value={versionNotes} onChange={(e) => setVersionNotes(e.target.value)} placeholder={t('edit.versionNotesPlaceholder')} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm mb-3" />
        <div className="flex flex-col sm:flex-row gap-3"><input ref={fileRef} type="file" accept=".zip" className="flex-1 text-sm min-w-0" /><button type="button" onClick={handleUpload} disabled={uploading} className="w-full sm:w-auto px-5 py-2 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-700 disabled:opacity-50">{uploading ? t('edit.uploading') : t('edit.upload')}</button></div>
      </div>

      {/* ── 版本历史 ── */}
      <div className="mb-10 p-5 sm:p-6 border rounded-xl bg-white">
        <h2 className="text-xl font-bold mb-4">{t('edit.versions')}</h2>
        <div className="space-y-2 mb-4">{versions.length === 0 && <p className="text-gray-500 text-sm">No versions yet.</p>}
          {versions.map((v) => { const isLatest = skill.latest_version_id === v.id; return (<div key={v.id} className="p-3 bg-gray-50 rounded-lg"><div className="flex items-center justify-between"><div><span className="font-mono font-medium">v{v.version}</span><span className="text-xs text-gray-500 ml-3">{v.size ? `${(v.size / 1024).toFixed(1)} KB · ` : ''}{new Date(v.created_at).toLocaleString()}</span></div><div className="flex items-center gap-2">{isLatest && <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">{t('detail.latest')}</span>}{!isLatest && <button type="button" onClick={() => handleDeleteVersion(v.id, v.version)} className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50">{t('edit.deleteVersion')}</button>}</div></div>{v.notes && <p className="text-xs text-gray-500 mt-1 ml-1">{v.notes}</p>}</div>); })}
        </div>
      </div>

      {/* ── 编辑信息表单 ── */}
      <form onSubmit={handleSave} className="space-y-5 p-5 sm:p-6 border rounded-xl bg-white">
        <Field label={t('edit.name')} required><input type="text" value={form.name} onChange={onChange('name')} required className="w-full px-3 py-2 border rounded-lg" /></Field>
        <div data-color-mode="light" className="md-editor-clean">
          <style>{`
            .md-editor-clean .w-md-editor-toolbar { display: none !important; }
            .md-editor-clean .w-md-editor-text-pre,
            .md-editor-clean .w-md-editor-text-input,
            .md-editor-clean .w-md-editor-preview { scrollbar-width: none; }
            .md-editor-clean .w-md-editor-text-pre::-webkit-scrollbar,
            .md-editor-clean .w-md-editor-text-input::-webkit-scrollbar,
            .md-editor-clean .w-md-editor-preview::-webkit-scrollbar { display: none; }
          `}</style>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('edit.description')}
          </label>
          <MDEditor
            value={form.content_md}
            onChange={(val) => setForm((f) => ({ ...f, content_md: val || '' }))}
            height={350}
            preview="live"
            visibleDragbar={false}
          />
        </div>
        <Field label={t('edit.tags')}><input type="text" value={form.tags} onChange={onChange('tags')} placeholder="ai, nlp" className="w-full px-3 py-2 border rounded-lg" />
          {/* ── 预设标签 ── */}
          <div className="mt-3 space-y-2">
            <span className="text-xs text-gray-400">{t('tags.presetTags')}</span>
            {GROUP_KEYS.map(group => (
              <div key={group} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 shrink-0 w-10">{t(`tags.${group}`)}:</span>
                <div className="flex gap-1 flex-wrap">
                  {tagGroups[group].map(tag => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => addTag(tag)}
                      disabled={form.tags.split(/[,，]/).map(x => x.trim()).filter(Boolean).includes(tag)}
                      className="shrink-0 px-2 py-0.5 text-xs rounded-full border border-blue-300 text-blue-600 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-default transition"
                    >
                      {tt(tag)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Field>
        <Field label={t('edit.coverUrl')}><input type="text" value={form.cover_url} onChange={onChange('cover_url')} className="w-full px-3 py-2 border rounded-lg" /></Field>
        <Field label={t('edit.teamLabel')}>
          <div className="relative">
            <select value={form.owner_team_id} onChange={(e) => setForm((f) => ({ ...f, owner_team_id: e.target.value }))} className="w-full px-3 py-2 pr-10 border rounded-lg bg-white appearance-none">
              <option value="">{t('edit.teamPersonal')}</option>
              {myTeams.map((m: any) => (<option key={m.team.id} value={m.team.id}>{m.team.name}</option>))}
            </select>
            <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" viewBox="0 0 1024 1024" fill="currentColor"><path d="M543.962 746.182l384.163-401.629c17.681-18.504 17.68-48.475 0-66.947s-46.361-18.474-64.043 0L511.953 645.8l-352.155-368.194c-17.68-18.474-46.331-18.474-64.012 0s-17.682 48.444 0 66.947L479.949 746.182c17.652 18.504 46.331 18.504 64.012 0z"/></svg>
          </div>
          <span className="block text-xs text-gray-500 mt-1">{t('edit.teamHint')}</span>
        </Field>
        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={saving} className="px-5 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">{saving ? t('edit.saving') : t('edit.save')}</button>
          <Link href={`/skills/${skill.slug || skill.id}`} className="px-5 py-2 border rounded-lg font-medium hover:bg-gray-50">{t('edit.cancel')}</Link>
        </div>
      </form>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">{label}{required && <span className="text-red-500 ml-0.5">*</span>}</span>{children}</label>;
}
