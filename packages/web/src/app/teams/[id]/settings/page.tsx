'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../../../hooks/useTranslation';
import { fetchTagGroups } from '../../../../lib/tag-groups';

// 后端推荐价（与 platform_settings 种子一致）：月 ¥29 / 季 ¥79 / 年 ¥268
const RECOMMENDED_PLAN = { monthly: 29, quarterly: 79, yearly: 268 };

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
  const [editingTags, setEditingTags] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagGroups, setTagGroups] = useState<Record<string, string[]>>({});
  const [tagGroupsLoading, setTagGroupsLoading] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  const [togglingPublic, setTogglingPublic] = useState(false);
  // ── 团队会员定价 ──
  const [teamPlan, setTeamPlan] = useState<{ monthly: string; quarterly: string; yearly: string }>({ monthly: '', quarterly: '', yearly: '' });
  const [planLoading, setPlanLoading] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  // ── 成员管理（按邮箱邀请 / 改角色 / 移除）──
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'maintainer' | 'viewer'>('viewer');
  const [memberLoading, setMemberLoading] = useState(false);
  // ── 加入申请（公开申请 + owner 审批）──
  const [joinRequests, setJoinRequests] = useState<any[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);

  const load = async () => {
    const token = localStorage.getItem('token'); if (!token) return router.push('/auth');
    try {
      const res = await fetch(`/api/teams/${params.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      const tData = await res.json(); setTeam(tData); setForm({ name: tData.name ?? '', description: tData.description ?? '' }); setIsPublic(tData.is_public !== false);
      // 加入申请（owner 或维护者可拉取待审列表）
      if (tData.is_owner || tData.is_manager) {
        setRequestsLoading(true);
        fetch(`/api/teams/${params.id}/join-requests`, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => (r.ok ? r.json() : []))
          .then((list) => setJoinRequests(Array.isArray(list) ? list : []))
          .catch(() => setJoinRequests([]))
          .finally(() => setRequestsLoading(false));
      }
      // 团队会员定价
      setPlanLoading(true);
      fetch(`/api/pay/membership/plan?targetType=team&targetId=${encodeURIComponent(params.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => {
          // 优先用后端 suggested 作为推荐价 fallback
          const ref = p?.suggested
            ? { monthly: Math.round(p.suggested.monthly / 100), quarterly: Math.round(p.suggested.quarterly / 100), yearly: Math.round(p.suggested.yearly / 100) }
            : RECOMMENDED_PLAN;
          if (p?.hasPlan && p.plans) {
            setTeamPlan({
              monthly: (p.plans.monthly || 0) > 0 ? String((p.plans.monthly || 0) / 100) : '',
              quarterly: (p.plans.quarterly || 0) > 0 ? String((p.plans.quarterly || 0) / 100) : '',
              yearly: (p.plans.yearly || 0) > 0 ? String((p.plans.yearly || 0) / 100) : '',
            });
          } else {
            // 未设置时全部留空，placeholder 显示建议价，避免被误解为已填好的价格
            setTeamPlan({ monthly: '', quarterly: '', yearly: '' });
          }
        })
        .catch(() => {})
        .finally(() => setPlanLoading(false));
    } catch (e: any) { setError(e.message || 'Load failed'); }
    finally { setLoading(false); }
  };

  const handleSavePlan = async () => {
    const token = localStorage.getItem('token'); if (!token) return;
    setSavingPlan(true);
    try {
      const res = await fetch('/api/pay/membership/plan', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          targetType: 'team',
          targetId: params.id,
          monthly_cents: Math.round(Number(teamPlan.monthly || 0) * 100),
          quarterly_cents: Math.round(Number(teamPlan.quarterly || 0) * 100),
          yearly_cents: Math.round(Number(teamPlan.yearly || 0) * 100),
        }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
      alert(t('team.membershipSaved'));
    } catch (err: any) { alert(t('team.saveFailed') + ': ' + err.message); }
    finally { setSavingPlan(false); }
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

  // 标签分组中文名（仅展示 scene/role/category，过滤系统自动打的 source 组）
  const TAG_GROUP_LABELS: Record<string, string> = { scene: '场景', role: '角色', category: '分类' };

  const handleTogglePublic = async (next: boolean) => {
    const token = localStorage.getItem('token'); if (!token) return;
    setTogglingPublic(true);
    try {
      setIsPublic(next);
      const res = await fetch(`/api/teams/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_public: next }),
      });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
    } catch (err: any) {
      setIsPublic(!next); // 失败回滚
      alert('更新失败: ' + err.message);
    } finally {
      setTogglingPublic(false);
    }
  };

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
    setSelectedTags(team?.tags ?? []);
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
      const res = await fetch(`/api/teams/${params.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tags: selectedTags }),
      });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.message || `HTTP ${res.status}`); }
      setEditingTags(false); await load();
    } catch (err: any) { alert(t('team.saveFailed') + ': ' + err.message); }
    finally { setSavingTags(false); }
  };

  const roleLabel = (role: string) =>
    role === 'owner' ? t('team.roleOwner') : role === 'maintainer' ? t('team.roleMaintainer') : t('team.roleViewer');

  // 按邮箱添加成员（后端查到已注册用户后直接加入，无需对方确认）
  const handleAddMember = async () => {
    const token = localStorage.getItem('token'); if (!token) return;
    const email = inviteEmail.trim();
    if (!email) { alert(t('team.emailNotFound')); return; }
    setMemberLoading(true);
    try {
      const res = await fetch(`/api/teams/${params.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || t('team.emailNotFound'));
      setInviteEmail('');
      alert(t('team.memberAdded'));
      await load();
    } catch (err: any) { alert(err.message || t('team.emailNotFound')); }
    finally { setMemberLoading(false); }
  };

  const handleChangeRole = async (userId: string, role: string) => {
    const token = localStorage.getItem('token'); if (!token) return;
    setMemberLoading(true);
    try {
      const res = await fetch(`/api/teams/${params.id}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || t('team.invalidRole'));
      await load();
    } catch (err: any) { alert(err.message || t('team.invalidRole')); }
    finally { setMemberLoading(false); }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!confirm(t('team.removeMember') + '?')) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setMemberLoading(true);
    try {
      const res = await fetch(`/api/teams/${params.id}/members/${userId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || t('team.cannotRemoveOwner'));
      alert(t('team.memberRemoved'));
      await load();
    } catch (err: any) { alert(err.message || t('team.cannotRemoveOwner')); }
    finally { setMemberLoading(false); }
  };

  // 审批加入申请：approve 加入成员；reject 仅标记
  const reviewRequest = async (userId: string, action: 'approve' | 'reject', role: 'maintainer' | 'viewer' = 'viewer') => {
    const token = localStorage.getItem('token'); if (!token) return;
    setRequestsLoading(true);
    try {
      const res = await fetch(`/api/teams/${params.id}/join-requests/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Failed');
      setJoinRequests((list) => list.filter((r) => r.user_id !== userId));
      if (action === 'approve') await load(); // 刷新成员列表
    } catch (err: any) { alert(err.message || 'Failed'); }
    finally { setRequestsLoading(false); }
  };

  if (loading) return <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center text-neutral-500">{t('skills.loading')}</div>;
  if (error) return (<div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center"><h1 className="text-2xl font-bold mb-2">{t('team.cannotLoad')}</h1><p className="text-neutral-500 mb-6">{error}</p><Link href={`/teams/${params.id}`} className="text-brand-600 underline">{t('team.backToTeam')}</Link></div>);
  if (!team) return null;

  const members = team.members ?? [];
  // owner 或维护者均可管理成员（添加 / 移除 / 审批申请）；改角色等仍限 owner
  const canManage = team.is_owner || team.is_manager;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <Link href={`/teams/${params.id}`} className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        {t('team.backToTeam')}
      </Link>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ===== 主列（占 2/3） ===== */}
        <div className="flex flex-col gap-6 lg:col-span-2">

          {/* 基本信息 Hero 卡 */}
          <div className="border rounded-xl bg-white overflow-hidden">
            <div className="relative h-24 bg-gradient-to-r from-brand-500 to-cyan-400">
              <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-t from-white via-white/50 to-transparent"></div>
            </div>
            <div className="px-6 pb-6">
              <div className="-mt-10 flex items-end gap-4">
                <div className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl border-4 border-white bg-white text-2xl font-bold text-brand-700 shadow">
                  {(team.name || '').charAt(0)}
                </div>
                <div className="pb-1 flex-1">
                  {!editing ? (
                    <>
                      <h1 className="text-2xl font-bold">{team.name}</h1>
                      {team.description && <p className="text-neutral-600 mt-2 text-sm">{team.description}</p>}
                    </>
                  ) : (
                    <form onSubmit={handleSave} className="w-full space-y-3">
                      <label className="block">
                        <span className="block text-sm font-medium text-neutral-700 mb-1">Team name</span>
                        <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className="w-full px-3 py-2 border rounded-lg" />
                      </label>
                      <label className="block">
                        <span className="block text-sm font-medium text-neutral-700 mb-1">Description</span>
                        <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} className="w-full px-3 py-2 border rounded-lg" />
                      </label>
                      <div className="flex gap-2 pt-1">
                        <button type="submit" disabled={saving || !form.name.trim()} className="px-5 py-2 bg-neutral-900 text-white rounded-lg font-medium hover:bg-neutral-900 disabled:opacity-50">{saving ? t('team.saving') : t('team.save')}</button>
                        <button type="button" onClick={() => { setEditing(false); setForm({ name: team.name, description: team.description ?? '' }); }} className="px-5 py-2 border rounded-lg font-medium hover:bg-neutral-100">{t('team.cancel')}</button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
              {!editing && team.is_owner && (
                <div className="mt-4 flex gap-2">
                  <button onClick={() => setEditing(true)} className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-neutral-100">{t('team.edit')}</button>
                  <button onClick={handleDelete} disabled={deleting} className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50">{deleting ? t('team.deleting') : t('team.delete')}</button>
                </div>
              )}
            </div>
          </div>

          {/* 团队标签 */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">团队标签</h2>
              {team.is_owner && !editingTags && (
                <button onClick={handleStartEditTags} className="text-sm text-brand-600 hover:text-brand-700 font-medium">编辑</button>
              )}
            </div>
            {editingTags ? (
              <div className="p-5 border rounded-xl bg-white space-y-3">
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
                              <button key={tag} type="button" onClick={() => toggleTag(tag)}
                                className={`text-xs px-2.5 py-1 rounded-full border transition ${active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-neutral-600 border-neutral-300 hover:border-brand-300'}`}>
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
                    <button onClick={handleSaveTags} disabled={savingTags} className="px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">{savingTags ? t('team.saving') : t('team.save')}</button>
                    <button onClick={() => { setEditingTags(false); setSelectedTags([]); }} className="px-4 py-1.5 border text-sm rounded hover:bg-neutral-100">{t('team.cancel')}</button>
                  </div>
                </div>
              </div>
            ) : (
              team.tags && team.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {team.tags.map((tag: string) => (
                    <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">{tag}</span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-neutral-400">暂无团队标签，点击「编辑」添加</p>
              )
            )}
          </div>

          {/* 团队会员定价 */}
          {team.is_owner && (
            <div className="p-6 border rounded-xl bg-white">
              <h2 className="text-xl font-bold mb-1">{t('team.membershipTitle')}</h2>
              <p className="text-sm text-neutral-500 mb-2">{t('team.membershipHint')}</p>
              <p className="text-xs text-brand-600 mb-4">{t('team.membershipRecommended')}</p>
              {planLoading ? (
                <div className="text-sm text-neutral-400">{t('team.loading')}</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <PlanCard label={t('pay.planMonthly')} value={teamPlan.monthly} placeholder={`建议${RECOMMENDED_PLAN.monthly}`} onChange={(v) => setTeamPlan((p) => ({ ...p, monthly: v }))} />
                    <PlanCard label={t('pay.planQuarterly')} value={teamPlan.quarterly} placeholder={`建议${RECOMMENDED_PLAN.quarterly}`} onChange={(v) => setTeamPlan((p) => ({ ...p, quarterly: v }))} />
                    <PlanCard label={t('pay.planYearly')} value={teamPlan.yearly} placeholder={`建议${RECOMMENDED_PLAN.yearly}`} onChange={(v) => setTeamPlan((p) => ({ ...p, yearly: v }))} />
                  </div>
                  <button onClick={handleSavePlan} disabled={savingPlan}
                    className="mt-4 w-full px-4 py-2 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
                    {savingPlan ? t('team.saving') : t('team.save')}
                  </button>
                </>
              )}
            </div>
          )}

          {/* 成员管理 */}
          <div>
            <h2 className="text-xl font-bold mb-4">{t('team.members')} ({members.length})</h2>
            {canManage && (
              <div className="mb-4 p-4 border rounded-xl bg-neutral-50 flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-neutral-600 mb-1">{t('team.inviteTitle')}</label>
                  <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder={t('team.inviteEmailPlaceholder')} className="w-full px-3 py-2 border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">{t('team.inviteRoleLabel')}</label>
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'maintainer' | 'viewer')} className="px-3 py-2 border rounded-lg text-sm bg-white">
                    <option value="maintainer">{t('team.roleMaintainer')}</option>
                    <option value="viewer">{t('team.roleViewer')}</option>
                  </select>
                </div>
                <button onClick={handleAddMember} disabled={memberLoading || !inviteEmail.trim()} className="px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-50">
                  {memberLoading ? t('team.saving') : t('team.addMember')}
                </button>
              </div>
            )}
            <div className="space-y-2">
              {members.map((m: any) => {
                const isOwner = m.role === 'owner';
                return (
                  <div key={m.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <div className="font-medium">{m.user?.name || m.user?.email || m.user_id.slice(0, 8)}</div>
                      <div className="text-xs text-neutral-500">{m.user?.email}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {team.is_owner && !isOwner ? (
                        <select
                          value={m.role}
                          disabled={memberLoading}
                          onChange={(e) => handleChangeRole(m.user_id, e.target.value)}
                          className="text-xs px-2 py-1 border rounded bg-white"
                        >
                          <option value="maintainer">{t('team.roleMaintainer')}</option>
                          <option value="viewer">{t('team.roleViewer')}</option>
                        </select>
                      ) : (
                        <span className="text-xs px-2 py-1 bg-neutral-100 rounded">{roleLabel(m.role)}</span>
                      )}
                      {canManage && !isOwner && (
                        <button onClick={() => handleRemoveMember(m.user_id)} disabled={memberLoading} className="text-xs text-danger-500 hover:underline">
                          {memberLoading ? t('team.removingMember') : t('team.removeMember')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ===== 侧栏（占 1/3，与资料卡顶端对齐） ===== */}
        <aside className="flex flex-col gap-6">
          {/* 对外展示开关 */}
          {team.is_owner && (
            <div className="p-6 border rounded-xl bg-white">
              <h2 className="text-base font-bold text-neutral-900">{t('team.publicDisplay')}</h2>
              <p className="text-sm text-neutral-400 mt-1">{t('team.publicDisplayDesc')}</p>
              <div className="mt-4 flex items-center justify-between rounded-lg bg-neutral-50 px-4 py-3">
                <span className="text-sm font-medium text-neutral-700">{t('team.publicOn')}</span>
                <label className="inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={isPublic}
                    disabled={togglingPublic}
                    onChange={(e) => handleTogglePublic(e.target.checked)}
                  />
                  <div className="relative w-11 h-6 bg-neutral-200 peer-focus:outline-none rounded-full peer-checked:bg-brand-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                </label>
              </div>
              <p className={`mt-2 text-xs ${isPublic ? 'text-emerald-600' : 'text-neutral-400'}`}>
                {isPublic ? t('team.publicEnabled') : t('team.publicDisabled')}
              </p>
            </div>
          )}

          {/* 加入申请（owner 或维护者审批） */}
          {canManage && (
            <div>
              <h2 className="text-xl font-bold mb-4">{t('team.joinRequests')} ({joinRequests.length})</h2>
              {requestsLoading ? (
                <p className="text-sm text-neutral-400">{t('team.loading')}</p>
              ) : joinRequests.length === 0 ? (
                <p className="text-sm text-neutral-400">{t('team.noJoinRequests')}</p>
              ) : (
                <div className="space-y-2">
                  {joinRequests.map((r: any) => (
                    <div key={r.user_id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="min-w-0">
                        <div className="font-medium">{r.user?.name || r.user?.email || r.user_id.slice(0, 8)}</div>
                        <div className="text-xs text-neutral-500 truncate">{r.user?.email}</div>
                        {r.message && <div className="text-xs text-neutral-500 mt-1">“{r.message}”</div>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <select
                          defaultValue="viewer"
                          disabled={requestsLoading}
                          onChange={(e) => reviewRequest(r.user_id, 'approve', e.target.value as 'maintainer' | 'viewer')}
                          className="text-xs px-2 py-1 border rounded bg-white"
                        >
                          <option value="maintainer">{t('team.roleMaintainer')}</option>
                          <option value="viewer">{t('team.roleViewer')}</option>
                        </select>
                        <button onClick={() => reviewRequest(r.user_id, 'approve')} disabled={requestsLoading} className="text-xs px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50">
                          {t('team.approve')}
                        </button>
                        <button onClick={() => reviewRequest(r.user_id, 'reject')} disabled={requestsLoading} className="text-xs px-3 py-1.5 border border-neutral-300 rounded hover:bg-neutral-100">
                          {t('team.reject')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function PlanCard({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <label className="text-sm text-neutral-500">{label}</label>
      <div className="mt-2 flex items-center rounded-lg border border-neutral-200 px-3">
        <span className="text-neutral-400 text-sm">¥</span>
        <input type="number" step="0.01" min="0" value={value} placeholder={placeholder || '0'} onChange={(e) => onChange(e.target.value)}
          className="w-full py-1.5 text-base font-semibold outline-none ring-0 focus:ring-0 focus:outline-none placeholder:text-sm placeholder:font-normal placeholder:text-neutral-300" />
      </div>
    </div>
  );
}
