'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubTagGroupsPage() {
  const { t, tt } = useTranslation();
  const [groups, setGroups] = useState<any[]>([]);
  const [newGroup, setNewGroup] = useState({ key: '', name: '', tagsStr: '' });
  const [editing, setEditing] = useState<{ id: string; name: string; tagsStr: string } | null>(null);
  const [msg, setMsg] = useState('');

  const fetchGroups = useCallback(async () => {
    const token = getToken(); if (!token) return;
    const r = await fetch('/api/admin/tag-groups', { headers: { Authorization: `Bearer ${token}` } });
    setGroups(await r.json());
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const create = async () => {
    const token = getToken(); if (!token) return;
    if (!newGroup.key || !newGroup.name) return;
    const tags = newGroup.tagsStr.split(/[，,]\s*/).map(t => t.trim()).filter(Boolean);
    await fetch('/api/admin/tag-groups', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ key: newGroup.key, name: newGroup.name, tags }) });
    setNewGroup({ key: '', name: '', tagsStr: '' });
    setMsg('Created');
    fetchGroups();
  };

  const update = async () => {
    if (!editing) return;
    const token = getToken(); if (!token) return;
    const tags = editing.tagsStr.split(/[，,]\s*/).map(t => t.trim()).filter(Boolean);
    await fetch(`/api/admin/tag-groups/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: editing.name, tags }) });
    setEditing(null);
    setMsg('Updated');
    fetchGroups();
  };

  const del = async (id: string) => {
    if (!confirm('Delete this group?')) return;
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/tag-groups/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchGroups();
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{t('admin.tagGroups')}</h1>
      <p className="text-xs text-gray-500 mb-4">{t('admin.tagGroupsDesc')}</p>
      {msg && <p className="text-sm text-green-600 mb-2">{msg}</p>}

      {/* Add new */}
      <div className="bg-white border rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold mb-3">{t('admin.addGroup')}</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs text-gray-500">{t('admin.tagKey')}</label>
            <input value={newGroup.key} onChange={e => setNewGroup({ ...newGroup, key: e.target.value })} className="w-24 px-2 py-1.5 text-sm border rounded" placeholder="role" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('admin.displayName')}</label>
            <input value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} className="w-24 px-2 py-1.5 text-sm border rounded" placeholder="role" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('admin.tagsComma')}</label>
            <input value={newGroup.tagsStr} onChange={e => setNewGroup({ ...newGroup, tagsStr: e.target.value })} className="w-64 px-2 py-1.5 text-sm border rounded" placeholder={t('admin.tagsPlaceholder')} />
          </div>
          <button onClick={create} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">{t('admin.add')}</button>
        </div>
      </div>

      {/* Existing groups */}
      {groups.map(g => (
        <div key={g.id} className="bg-white border rounded-xl p-4 mb-3">
          {editing !== null && editing.id === g.id ? (
            <div className="flex flex-wrap gap-3 items-end">
              <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} className="w-24 px-2 py-1.5 text-sm border rounded" />
              <input value={editing.tagsStr} onChange={e => setEditing({ ...editing, tagsStr: e.target.value })} className="w-96 px-2 py-1.5 text-sm border rounded" />
              <button onClick={update} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded">{t('admin.save')}</button>
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm bg-gray-200 rounded">{t('admin.cancel')}</button>
            </div>
          ) : (
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono text-gray-500">{g.key}</span>
                  <span className="text-sm font-medium text-gray-800">{g.name}</span>
                  <span className="text-xs text-gray-400">({(g.tags?.length || 0)} {t('admin.nTags')})</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(g.tags || []).map((tag: string) => (
                    <span key={tag} className={`px-2 py-0.5 rounded text-xs ${tag === '精选' ? 'bg-orange-50 text-orange-800 border border-orange-200' : 'bg-blue-50 text-blue-700'}`}>{tag}</span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 shrink-0 ml-4">
                <button onClick={() => setEditing({ id: g.id, name: g.name, tagsStr: (g.tags || []).join(', ') })} className="text-xs text-blue-600 hover:underline">{t('admin.edit')}</button>
                <button onClick={() => del(g.id)} className="text-xs text-red-500 hover:underline">{t('admin.delete')}</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
