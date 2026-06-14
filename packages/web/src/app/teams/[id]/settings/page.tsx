'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../../../hooks/useTranslation';

export default function TeamSettings({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { t } = useTranslation();
  const [team, setTeam] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    const token = localStorage.getItem('token'); if (!token) return router.push('/auth');
    try {
      const res = await fetch(`/api/teams/${params.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      const tData = await res.json(); setTeam(tData); setForm({ name: tData.name ?? '', description: tData.description ?? '' });
    } catch (e: any) { setError(e.message || 'Load failed'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [params.id]);

  const handleSave = async (e: React.FormEvent) => { e.preventDefault(); const token = localStorage.getItem('token'); if (!token) return; setSaving(true);
    try {
      const res = await fetch(`/api/teams/${params.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: form.name.trim(), description: form.description }) });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      setEditing(false); await load();
    } catch (err: any) { alert(t('team.saveFailed') + ': ' + err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => { if (!confirm(t('team.deleteConfirm').replace('{name}', team.name))) return; const token = localStorage.getItem('token'); if (!token) return; setDeleting(true);
    try {
      const res = await fetch(`/api/teams/${params.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      router.push('/dashboard');
    } catch (err: any) { alert(t('team.deleteFailed') + ': ' + err.message); setDeleting(false); }
  };

  if (loading) return <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center text-neutral-500">{t('skills.loading')}</div>;
  if (error) return (<div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center"><h1 className="text-2xl font-bold mb-2">{t('team.cannotLoad')}</h1><p className="text-neutral-500 mb-6">{error}</p><Link href={`/teams/${params.id}`} className="text-brand-600 underline">{t('team.backToTeam')}</Link></div>);
  if (!team) return null;

  const skills = team.skills ?? [];
  const members = team.members ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <Link href={`/teams/${params.id}`} className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900">
        <svg className="w-5 h-5" viewBox="0 0 1024 1024" fill="currentColor"><path d="M277.818 543.962l401.629 384.163c18.504 17.681 48.475 17.68 66.947 0s18.474-46.361 0-64.043L378.2 511.953l368.194-352.155c18.474-17.68 18.474-46.331 0-64.012-18.474-17.682-48.444-17.682-66.947 0L277.818 479.949c-18.504 17.652-18.504 46.331 0 64.012z"/></svg>
        {t('team.backToTeam')}
      </Link>
      <div className="mt-4 mb-10 p-6 border rounded-xl bg-white">
        {!editing ? (<>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div><h1 className="text-2xl sm:text-3xl font-bold">{team.name}</h1>{team.description && <p className="text-neutral-600 mt-2">{team.description}</p>}{team.my_role && <span className="inline-block mt-3 text-xs px-2 py-1 bg-neutral-100 rounded capitalize">{t('team.yourRole')}: {team.my_role}</span>}</div>
            {team.is_owner && (<div className="flex gap-2 shrink-0"><button onClick={() => setEditing(true)} className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-neutral-100">{t('team.edit')}</button><button onClick={handleDelete} disabled={deleting} className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50">{deleting ? t('team.deleting') : t('team.delete')}</button></div>)}
          </div>
        </>) : (
          <form onSubmit={handleSave} className="space-y-4">
            <label className="block"><span className="block text-sm font-medium text-neutral-700 mb-1">Team name</span><input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className="w-full px-3 py-2 border rounded-lg" /></label>
            <label className="block"><span className="block text-sm font-medium text-neutral-700 mb-1">Description</span><textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} className="w-full px-3 py-2 border rounded-lg" /></label>
            <div className="flex gap-2 pt-1"><button type="submit" disabled={saving || !form.name.trim()} className="px-5 py-2 bg-neutral-900 text-white rounded-lg font-medium hover:bg-neutral-900 disabled:opacity-50">{saving ? t('team.saving') : t('team.save')}</button><button type="button" onClick={() => { setEditing(false); setForm({ name: team.name, description: team.description ?? '' }); }} className="px-5 py-2 border rounded-lg font-medium hover:bg-neutral-100">{t('team.cancel')}</button></div>
          </form>
        )}
      </div>
      <div className="mb-10"><h2 className="text-xl font-bold mb-4">{t('team.members')} ({members.length})</h2>
        <div className="space-y-2">{members.map((m: any) => (<div key={m.id} className="flex items-center justify-between p-3 border rounded-lg"><div><div className="font-medium">{m.user?.name || m.user?.email || m.user_id.slice(0, 8)}</div><div className="text-xs text-neutral-500">{m.user?.email}</div></div><span className="text-xs px-2 py-1 bg-neutral-100 rounded capitalize">{m.role}</span></div>))}</div>
      </div>
      <div><h2 className="text-xl font-bold mb-4">{t('team.teamSkills')} ({skills.length})</h2>
        {skills.length === 0 ? (<div className="p-6 border border-dashed rounded-xl text-center text-neutral-500 text-sm">{t('team.noSkills')}<br /><span className="text-xs">{t('team.noSkillsHint')}</span></div>) : (
          <div className="space-y-3">{skills.map((s: any) => (<Link key={s.id} href={`/skills/${s.slug || s.id}`} className="block p-4 border rounded-xl hover:border-neutral-400 hover:bg-neutral-100 transition"><div className="flex items-center justify-between"><div><h3 className="font-bold">{s.name}</h3>{s.short_summary && <p className="text-sm text-neutral-500 mt-1">{s.short_summary}</p>}</div><div className="flex items-center gap-3 text-xs shrink-0 ml-4"><span className="flex items-center gap-1" title={t('detail.likes')}><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="#F43F5E"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><span className="text-neutral-600">{s.stats?.likes_total ?? 0}</span></span><span className="flex items-center gap-1" title={t('detail.downloads')}><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="#5C85FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span className="text-neutral-600">{s.stats?.downloads_total ?? 0}</span></span></div></div></Link>))}</div>
        )}
      </div>
    </div>
  );
}
