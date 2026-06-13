'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubTeamsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const r = await fetch(`/api/admin/teams?page=${page}&size=20`, { headers: { Authorization: `Bearer ${token}` } });
    setData(await r.json());
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const saveEdit = async () => {
    if (!editing) return;
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/teams/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: editing.name, description: editing.description }) });
    setEditing(null);
    fetchData();
  };

  const deleteTeam = async (id: string) => {
    if (!confirm('Delete this team?')) return;
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/teams/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-4">{t('admin.teams')}</h1>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th className="px-4 py-3 text-left">{t('admin.thName')}</th><th className="px-4 py-3 text-left hidden md:table-cell">{t('admin.thDescription')}</th><th className="px-4 py-3 text-center">{t('admin.thMembers')}</th><th className="px-4 py-3 text-right">{t('admin.thActions')}</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.items || []).map((team: any) => (
              <tr key={team.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  {editing !== null && editing.id === team.id ? (
                    <div className="flex flex-col gap-2">
                      <input type="text" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} className="px-2 py-1 text-sm border rounded" />
                      <input type="text" value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} className="px-2 py-1 text-sm border rounded" placeholder={t('admin.thDescription')} />
                      <div className="flex gap-2">
                        <button onClick={saveEdit} className="px-2 py-1 text-xs bg-blue-600 text-white rounded">{t('admin.save')}</button>
                        <button onClick={() => setEditing(null)} className="px-2 py-1 text-xs bg-gray-200 rounded">{t('admin.cancel')}</button>
                      </div>
                    </div>
                  ) : (
                    <a href={`/teams/${team.id}`} target="_blank" className="font-medium text-blue-600 hover:underline">{team.name}</a>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell max-w-xs truncate">{team.description || '-'}</td>
                <td className="px-4 py-3 text-center">{team.member_count || 0}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing({ id: team.id, name: team.name, description: team.description || '' })} className="text-xs text-blue-600 hover:underline mr-3">{t('admin.edit')}</button>
                  <button onClick={() => deleteTeam(team.id)} className="text-xs text-red-500 hover:underline">{t('admin.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
