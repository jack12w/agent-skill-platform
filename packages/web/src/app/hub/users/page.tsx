'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubUsersPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState('');

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: '20' });
    if (search) p.set('search', search);
    try {
      const r = await fetch(`/api/admin/users?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      setData(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [page, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const updateUser = async (id: string, role: string) => {
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ role }) });
    setMsg(`Updated role to ${role}`);
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-1">{t('admin.users')}</h1>
      <div className="flex items-center gap-3 my-4">
        <input type="text" placeholder={t('admin.thSearch')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="px-3 py-1.5 text-sm border rounded-lg w-56 focus:outline-none focus:border-brand-400" />
        {msg && <span className="text-xs text-green-600">{msg}</span>}
      </div>

      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr><th className="px-4 py-3 text-left">{t('admin.thName')}</th><th className="px-4 py-3 text-left">{t('admin.thEmail')}</th><th className="px-4 py-3 text-center">{t('admin.thRole')}</th><th className="px-4 py-3 text-right">{t('admin.thActions')}</th></tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((u: any) => (
              <tr key={u.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3 font-medium">{u.name}</td>
                <td className="px-4 py-3 text-neutral-500">{u.email}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${u.role === 'admin' ? 'bg-accent-100 text-accent-700' : 'bg-neutral-100 text-neutral-500'}`}>{u.role || 'user'}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <select value={u.role || 'user'} onChange={e => updateUser(u.id, e.target.value)} className="text-xs border rounded px-2 py-1">
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > data.size && (
        <div className="flex justify-between mt-4 text-sm text-neutral-500">
          <span>{(data.page-1)*data.size+1}-{Math.min(data.page*data.size, data.total)} of {data.total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
            <button onClick={() => setPage(p => p+1)} disabled={page*data.size >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
