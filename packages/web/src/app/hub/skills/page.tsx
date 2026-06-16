'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

interface SkillItem {
  id: string; name: string; slug: string; status: string; tags: string[];
  created_at: string; updated_at: string;
  owner_user: { id: string; name: string; email: string };
  stats?: { likes_total: number; downloads_total: number };
}
interface SkillList { items: SkillItem[]; total: number; page: number; size: number }

function getToken() {
  try { return localStorage.getItem('token'); } catch { return null; }
}

export default function HubSkillsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<SkillList | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', short_summary: '', tags: '' });
  const [editingSkill, setEditingSkill] = useState<SkillItem | null>(null);

  const fetchData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), size: '20' });
    if (search) params.set('search', search);
    if (statusFilter) params.set('status', statusFilter);
    try {
      const res = await fetch(`/api/admin/skills?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed');
      setData(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [page, search, statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleAll = () => {
    if (!data) return;
    if (selected.size === data.items.length) setSelected(new Set());
    else setSelected(new Set(data.items.map(s => s.id)));
  };

  const batchAction = async (action: string) => {
    if (!selected.size) return;
    const token = getToken();
    if (!token) return;
    setActionLoading(action);
    try {
      const res = await fetch('/api/admin/skills/batch', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: Array.from(selected), action }),
      });
      if (!res.ok) throw new Error('Failed');
      setSelected(new Set());
      fetchData();
    } catch (e) { console.error(e); }
    finally { setActionLoading(''); }
  };

  const startEdit = (s: SkillItem) => {
    setEditingId(s.id);
    setEditingSkill(s);
    // 编辑时自动从输入框中移除「精选」（后端会保护它），避免管理员误删
    const otherTags = (s.tags || []).filter(t => t !== '精选').join(', ');
    setEditForm({ name: s.name, short_summary: s.slug, tags: otherTags });
  };
  const saveEdit = async () => {
    if (!editingId) return;
    const token = getToken();
    if (!token) return;
    try {
      await fetch(`/api/admin/skills/${editingId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: editForm.name, tags: editForm.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean) }),
      });
      setEditingId(null);
      fetchData();
    } catch (e) { console.error(e); }
  };

  const statusBadge = (s: string) =>
    s === 'published' ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500';

  return (
    <div className="max-w-full">
      <h1 className="text-xl font-bold text-neutral-900 mb-1">{t('admin.skills')}</h1>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-3 my-4">
        <input type="text" placeholder="Search..." value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="px-3 py-1.5 text-sm border rounded-lg w-48 focus:outline-none focus:border-brand-400" />
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }} className="px-3 py-1.5 text-sm border rounded-lg focus:outline-none">
          <option value="">{t('admin.allStatus')}</option>
          <option value="published">{t('admin.statusPublished')}</option>
          <option value="archived">{t('admin.statusArchived')}</option>
        </select>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-neutral-500">{selected.size} selected</span>
            <button onClick={() => batchAction('publish')} disabled={!!actionLoading} className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">{t('admin.batchPublish')}</button>
            <button onClick={() => batchAction('unpublish')} disabled={!!actionLoading} className="px-3 py-1.5 text-xs bg-yellow-500 text-white rounded-lg hover:bg-yellow-600">{t('admin.batchUnpublish')}</button>
            <button onClick={() => { if (confirm(t('admin.confirmDelete'))) batchAction('delete'); }} disabled={!!actionLoading} className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700">{t('admin.batchDelete')}</button>
          </div>
        )}
      </div>

      {/* 表格 */}
      {loading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : (
        <>
          <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left w-10"><input type="checkbox" checked={data ? selected.size === data.items.length && data.items.length > 0 : false} onChange={toggleAll} /></th>
                  <th className="px-4 py-3 text-left">{t('admin.thName')}</th>
                  <th className="px-4 py-3 text-left hidden md:table-cell">{t('admin.thOwner')}</th>
                  <th className="px-4 py-3 text-left hidden lg:table-cell">{t('admin.thTags')}</th>
                  <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
                  <th className="px-4 py-3 text-right hidden sm:table-cell">{t('admin.thActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data?.items.map(s => (
                  <tr key={s.id} className="hover:bg-neutral-100">
                    <td className="px-4 py-3"><input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                    <td className="px-4 py-3">
                      {editingId === s.id ? (
                        <div className="space-y-2 max-w-sm">
                          <input type="text" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} className="w-full px-2 py-1 text-sm border rounded" />
                          <div className="flex items-center gap-2">
                            <input type="text" value={editForm.tags} onChange={e => setEditForm({ ...editForm, tags: e.target.value })} className="flex-1 px-2 py-1 text-sm border rounded" placeholder="tag1, tag2" />
                            {editingSkill?.tags?.includes('精选') && (
                              <span className="shrink-0 px-2 py-0.5 rounded text-xs bg-orange-50 text-orange-700 border border-orange-200 whitespace-nowrap">精选 ✓</span>
                            )}
                          </div>
                          <div className="text-xs text-neutral-400">{editingSkill?.tags?.includes('精选') ? '「精选」标签受保护，保存时会自动保留' : ''}</div>
                          <div className="flex gap-2">
                            <button onClick={saveEdit} className="px-2 py-1 text-xs bg-brand-600 text-white rounded">{t('admin.save')}</button>
                            <button onClick={() => setEditingId(null)} className="px-2 py-1 text-xs bg-neutral-200 rounded">{t('admin.cancel')}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <a href={`/skills/${s.slug}`} target="_blank" className="font-medium text-brand-600 hover:underline">{s.name}</a>
                          <div className="text-xs text-neutral-400 hidden sm:block">{s.slug?.slice(0, 20)}...</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-neutral-600 hidden md:table-cell">{s.owner_user?.name || s.owner_user?.email}</td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(() => {
                          const allTags = s.tags || [];
                          const featured = allTags.filter((t: string) => t === '精选');
                          const others = allTags.filter((t: string) => t !== '精选');
                          const display = [...featured, ...others].slice(0, 3);
                          const hidden = allTags.length - display.length;
                          return (
                            <>
                              {display.map((t: string) => (
                                <span key={t} className={`px-1.5 py-0.5 rounded text-xs ${t === '精选' ? 'bg-orange-50 text-orange-800 border border-orange-200' : 'bg-neutral-100 text-neutral-600'}`}>{t}</span>
                              ))}
                              {hidden > 0 && <span className="text-xs text-neutral-400">+{hidden}</span>}
                            </>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(s.status)}`}>{s.status}</span></td>
                    <td className="px-4 py-3 text-right hidden sm:table-cell">
                      <button onClick={() => startEdit(s)} className="text-xs text-brand-600 hover:underline">{t('admin.edit')}</button>
                    </td>
                  </tr>
                ))}
                {(!data || data.items.length === 0) && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-neutral-400 text-sm">{t('admin.noSkills')}</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          {data && data.total > data.size && (
            <div className="flex items-center justify-between mt-4 text-sm text-neutral-500">
              <span>{(data.page - 1) * data.size + 1}-{Math.min(data.page * data.size, data.total)} of {data.total}</span>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
                <button onClick={() => setPage(p => p + 1)} disabled={page * data.size >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
