'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useTranslation from '../../hooks/useTranslation';
import { fetchTagGroups } from '../../lib/tag-groups';

export default function Dashboard() {
  const router = useRouter();
  const { t } = useTranslation();
  const [user, setUser] = useState<any>(null);
  const [teams, setTeams] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [editingBio, setEditingBio] = useState(false);
  const [profileBio, setProfileBio] = useState('');
  const [editingTags, setEditingTags] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagGroups, setTagGroups] = useState<Record<string, string[]>>({});
  const [tagGroupsLoading, setTagGroupsLoading] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const loadTeams = async (token: string) => {
    const res = await fetch('/api/teams/my', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setTeams(await res.json());
  };
  const reloadSkills = async () => {
    const token = localStorage.getItem('token'); if (!token) return;
    const res = await fetch('/api/skills?owner=me', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) { const data = await res.json(); setSkills(Array.isArray(data) ? data : data?.items ?? []); }
  };
  useEffect(() => {
    const userData = localStorage.getItem('user'); const token = localStorage.getItem('token');
    if (userData && userData !== 'undefined') { try { setUser(JSON.parse(userData)); } catch {} }
    if (token) { loadTeams(token); reloadSkills(); }
    setLoading(false);
  }, []);

  // 页面获得焦点时刷新数据（用户从编辑页等子页面返回时）
  useEffect(() => {
    const handleFocus = () => { reloadSkills(); };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // 首次登录展示引导弹窗
  useEffect(() => {
    if (user && !localStorage.getItem('skilldepot_onboarding_seen')) {
      setShowOnboarding(true);
    }
  }, [user]);

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault(); const name = newName.trim(); if (!name) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setCreating(true);
    try {
      const res = await fetch('/api/teams', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name, description: newDesc.trim() }) });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      setNewName(''); setNewDesc(''); setShowCreate(false); await loadTeams(token);
    } catch (err: any) { alert(t('dashboard.createTeamFailed') + ': ' + err.message); }
    finally { setCreating(false); }
  };

  const handleDeleteSkill = async (skillId: string, skillName: string) => {
    if (!confirm(t('dashboard.deleteConfirm').replace('{name}', skillName))) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setDeleting(skillId);
    try {
      const res = await fetch(`/api/skills/${skillId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      await reloadSkills();
    } catch (err: any) { alert(t('dashboard.deleteFailed') + ': ' + (err.message || String(err))); }
    finally { setDeleting(null); }
  };

  const handleSaveProfile = async () => {
    const token = localStorage.getItem('token'); if (!token) return;
    setSavingProfile(true);
    try {
      const body: Record<string, string> = {};
      if (editingName) body.name = profileName.trim();
      if (editingBio) body.bio = profileBio;
      const res = await fetch('/api/auth/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed');
      const updated = await res.json();
      setUser(updated);
      localStorage.setItem('user', JSON.stringify(updated));
      window.dispatchEvent(new Event('user-updated'));
      if (editingName) setEditingName(false);
      if (editingBio) setEditingBio(false);
    } catch { alert('保存失败'); }
    finally { setSavingProfile(false); }
  };

  const handleStartEditBio = () => {
    setProfileBio(user?.bio || '');
    setEditingBio(true);
  };

  // 标签分组中文名（仅展示 scene/role/category，过滤系统自动打的 source 组）
  const TAG_GROUP_LABELS: Record<string, string> = { scene: '场景', role: '角色', category: '分类' };

  const handleStartEditTags = async () => {
    setTagGroupsLoading(true);
    try {
      const groups = await fetchTagGroups();
      setTagGroups(groups);
    } catch {
      setTagGroups({});
    } finally {
      setTagGroupsLoading(false);
    }
    setSelectedTags(user?.tags ?? []);
    setEditingTags(true);
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleSaveTags = async () => {
    const token = localStorage.getItem('token'); if (!token) return;
    setSavingTags(true);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tags: selectedTags }),
      });
      if (!res.ok) throw new Error('Failed');
      const updated = await res.json();
      setUser(updated);
      localStorage.setItem('user', JSON.stringify(updated));
      window.dispatchEvent(new Event('user-updated'));
      setEditingTags(false);
    } catch { alert('保存失败'); }
    finally { setSavingTags(false); }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file || !user) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setUploadingAvatar(true);
    try {
      const formData = new FormData(); formData.append('file', file);
      const res = await fetch('/api/auth/me/avatar', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData,
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || 'Failed'); }
      const updated = await res.json();
      setUser(updated);
      localStorage.setItem('user', JSON.stringify(updated));
      window.dispatchEvent(new Event('user-updated'));
    } catch (e: any) { alert(e.message || '头像上传失败'); }
    finally { setUploadingAvatar(false); }
  };

  const dismissOnboarding = () => {
    localStorage.setItem('skilldepot_onboarding_seen', '1');
    setShowOnboarding(false);
  };

  if (!user) return <div className="p-24 text-center">Please <Link href="/auth" className="text-brand-600">login</Link> to view your dashboard.</div>;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6 mb-12 bg-transparent">
        <label className="relative cursor-pointer group shrink-0">
          <input type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" disabled={uploadingAvatar} />
          {user.avatar_url ? (
            <img src={user.avatar_url} alt={user.name} className="w-20 h-20 rounded-full object-cover border-2 border-neutral-200" />
          ) : (
            <div className="w-20 h-20 bg-brand-600 rounded-full flex items-center justify-center text-3xl font-bold text-white">{user.name[0]}</div>
          )}
          <div className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
            <span className="text-white text-xs font-medium">{uploadingAvatar ? '...' : '更换'}</span>
          </div>
        </label>
        <div className="flex-1 min-w-0">
          {editingName ? (
            <div className="flex items-center gap-2">
              <input value={profileName} onChange={e => setProfileName(e.target.value)} className="text-2xl sm:text-3xl font-bold w-full max-w-xs px-2 py-1 border rounded" autoFocus onKeyDown={e => { if (e.key === 'Enter') handleSaveProfile(); if (e.key === 'Escape') setEditingName(false); }} />
              <button onClick={handleSaveProfile} disabled={savingProfile || !profileName.trim()} className="shrink-0 px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">{savingProfile ? '...' : '保存'}</button>
              <button onClick={() => setEditingName(false)} className="shrink-0 px-3 py-1 border text-sm rounded hover:bg-neutral-100">取消</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-bold truncate">{user.name}</h1>
              <button onClick={() => { setProfileName(user.name); setEditingName(true); }} className="shrink-0 text-neutral-400 hover:text-brand-500">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
            </div>
          )}
          <p className="text-neutral-500 text-sm mt-0.5">{user.email}</p>
          {/* Bio 编辑区 */}
          <div className="mt-3">
            {editingBio ? (
              <div className="space-y-2">
                <textarea
                  value={profileBio}
                  onChange={e => setProfileBio(e.target.value.slice(0, 40))}
                  placeholder="用一句话介绍自己…"
                  maxLength={40}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-neutral-400">{profileBio.length}/40</span>
                  <div className="flex gap-2">
                    <button onClick={handleSaveProfile} disabled={savingProfile} className="px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
                      {savingProfile ? '...' : '保存'}
                    </button>
                    <button onClick={() => { setEditingBio(false); setProfileBio(''); }} className="px-3 py-1 border text-sm rounded hover:bg-neutral-100">取消</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <p className="text-sm text-neutral-600 flex-1 min-w-0 whitespace-pre-wrap break-words">
                  {user.bio || <span className="text-neutral-400">添加个人简介…</span>}
                </p>
                <button onClick={handleStartEditBio} className="shrink-0 text-neutral-400 hover:text-brand-500 mt-0.5">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
            )}
          </div>

          {/* 我的标签 编辑区 */}
          <div className="mt-3">
            {editingTags ? (
              <div className="space-y-3">
                {tagGroupsLoading ? (
                  <p className="text-xs text-neutral-400">加载标签中…</p>
                ) : (
                  Object.keys(TAG_GROUP_LABELS).map((key) => {
                    const list = tagGroups[key] ?? [];
                    if (list.length === 0) return null;
                    return (
                      <div key={key}>
                        <p className="text-xs font-medium text-neutral-500 mb-1.5">{TAG_GROUP_LABELS[key]}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {list.map((tag) => {
                            const active = selectedTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() => toggleTag(tag)}
                                className={`text-xs px-2.5 py-1 rounded-full border transition ${active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-neutral-600 border-neutral-300 hover:border-brand-300'}`}
                              >
                                {tag}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-neutral-400">已选 {selectedTags.length} 个</span>
                  <div className="flex gap-2">
                    <button onClick={handleSaveTags} disabled={savingTags} className="px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
                      {savingTags ? '...' : '保存'}
                    </button>
                    <button onClick={() => { setEditingTags(false); setSelectedTags([]); }} className="px-3 py-1 border text-sm rounded hover:bg-neutral-100">取消</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  {user?.tags && user.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {user.tags.map((tag: string) => (
                        <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">{tag}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-400">添加我的标签…</p>
                  )}
                </div>
                <button onClick={handleStartEditTags} className="shrink-0 text-neutral-400 hover:text-brand-500 mt-0.5">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="grid md:grid-cols-3 gap-12">
        <div className="md:col-span-2">
          <h2 className="text-2xl font-bold mb-6">{t('dashboard.mySkills')}</h2>
          <div className="space-y-4">
            {skills.map(skill => (
              <div key={skill.id} className="p-4 border rounded-xl flex justify-between items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold">{skill.name}</h3>
                    {skill.status === 'pending' && (
                      <span className="shrink-0 px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded-full">{t('dashboard.statusPending')}</span>
                    )}
                    {skill.status === 'archived' && (
                      <span className="shrink-0 px-2 py-0.5 text-xs font-medium bg-neutral-100 text-neutral-500 border border-neutral-200 rounded-full">已归档</span>
                    )}
                  </div>
                  <p className="text-sm text-neutral-500 line-clamp-2">{skill.short_summary}</p></div>
                <div className="flex items-center gap-3 min-w-[68px]">
                  <Link href={`/skills/${skill.slug || skill.id}`} className="text-brand-600 text-sm font-medium">{t('dashboard.manage')}</Link>
                  <button onClick={() => handleDeleteSkill(skill.id, skill.name)} disabled={deleting === skill.id} className="text-danger-500 text-sm font-medium hover:text-danger-700 disabled:opacity-40">{deleting === skill.id ? t('dashboard.deleting') : t('dashboard.delete')}</button>
                </div>
              </div>
            ))}
            {skills.length === 0 && <div className="text-neutral-400 py-8 border-2 border-dashed rounded-xl text-center">{t('dashboard.noSkills')}</div>}
            <Link href="/submit" className="block w-full py-4 text-center border-2 border-dashed rounded-xl text-brand-600 font-bold hover:bg-brand-50">{t('dashboard.addNewSkill')}</Link>
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-bold mb-6">{t('dashboard.myTeams')}</h2>
          <div className="space-y-4">
            {teams.map(m => (
              <Link key={m.team.id} href={`/teams/${m.team.id}`} className="flex items-center justify-between p-4 border rounded-xl hover:border-neutral-400 hover:bg-neutral-100 transition gap-3">
                <div><h3 className="font-bold">{m.team.name}</h3><p className="text-sm text-neutral-500 capitalize">{m.role}</p></div>
                <svg className="w-5 h-5 shrink-0 text-neutral-400" viewBox="0 0 1024 1024" fill="currentColor"><path d="M273.9 852.5c0 7.6 3.1 14.9 8.6 20.1l40.2 40.2c5.2 5.5 12.5 8.7 20.1 8.6 5.7 0 11.5-2.9 17.2-8.6L742.4 530.6c5.8-5.7 8.6-11.5 8.6-17.2 0-7.6-3.1-14.9-8.6-20.1L360.1 111c-5.7-5.7-11.5-8.6-17.2-8.6-7.6 0-14.9 3.1-20.1 8.6l-40.2 40.2c-5.5 5.2-8.7 12.5-8.6 20.1 0 5.7 2.9 11.5 8.6 17.2L604.4 513.3l-321.9 321.9c-5.8 5.8-8.6 11.5-8.6 17.3z"/></svg>
              </Link>
            ))}
            {teams.length === 0 && <div className="text-neutral-400 py-4 text-sm">{t('dashboard.noTeams')}</div>}
            {showCreate ? (
              <form onSubmit={handleCreateTeam} className="p-4 border rounded-xl space-y-3 bg-neutral-100">
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('dashboard.teamName')} required autoFocus className="w-full px-3 py-2 border rounded-lg text-sm" />
                <textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={t('dashboard.description')} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm" />
                <div className="flex gap-2">
                  <button type="submit" disabled={creating || !newName.trim()} className="flex-1 py-2 bg-neutral-900 text-white rounded-lg text-sm font-bold hover:bg-black disabled:opacity-50">{creating ? t('dashboard.creating') : t('dashboard.create')}</button>
                  <button type="button" onClick={() => { setShowCreate(false); setNewName(''); setNewDesc(''); }} className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-white">{t('dashboard.cancel')}</button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setShowCreate(true)} className="w-full py-3 bg-neutral-900 text-white rounded-lg font-bold hover:bg-black">{t('dashboard.createTeam')}</button>
            )}
          </div>
        </div>
      </div>
      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-in fade-in zoom-in">
            <div className="bg-gradient-to-r from-brand-600 to-brand-500 p-6 text-white text-center">
              <div className="text-4xl mb-2">🚀</div>
              <h2 className="text-xl font-bold">{t('dashboard.onboardingTitle')}</h2>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex gap-3">
                <span className="shrink-0 w-8 h-8 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center text-sm font-bold">1</span>
                <div>
                  <p className="font-semibold text-neutral-900 text-sm">{t('dashboard.onboardingStep1')}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{t('dashboard.onboardingStep1Desc')}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="shrink-0 w-8 h-8 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center text-sm font-bold">2</span>
                <div>
                  <p className="font-semibold text-neutral-900 text-sm">{t('dashboard.onboardingStep2')}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{t('dashboard.onboardingStep2Desc')}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="shrink-0 w-8 h-8 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center text-sm font-bold">3</span>
                <div>
                  <p className="font-semibold text-neutral-900 text-sm">{t('dashboard.onboardingStep3')}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{t('dashboard.onboardingStep3Desc')}</p>
                </div>
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={dismissOnboarding} className="flex-1 py-2.5 border border-neutral-300 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50">
                {t('dashboard.onboardingLater')}
              </button>
              <button onClick={() => { dismissOnboarding(); router.push('/submit'); }} className="flex-1 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-bold hover:bg-brand-700">
                {t('dashboard.onboardingStart')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
