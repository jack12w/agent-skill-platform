'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubCommentsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const r = await fetch(`/api/admin/comments?page=${page}&size=20`, { headers: { Authorization: `Bearer ${token}` } });
    setData(await r.json());
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const deleteComment = async (id: string) => {
    if (!confirm('Delete this comment?')) return;
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/comments/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-4">{t('admin.comments')}</h1>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th className="px-4 py-3 text-left">{t('admin.thComment')}</th><th className="px-4 py-3 text-left hidden md:table-cell">{t('admin.thSkill')}</th><th className="px-4 py-3 text-left">{t('admin.thUser')}</th><th className="px-4 py-3 text-left hidden sm:table-cell">{t('admin.thDate')}</th><th className="px-4 py-3 text-right">{t('admin.thDelete')}</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.items || []).map((c: any) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 max-w-xs truncate">{c.content}</td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <a href={`/skills/${c.skill?.slug || c.skill?.id}`} target="_blank" className="text-blue-600 hover:underline text-xs">{c.skill?.name}</a>
                </td>
                <td className="px-4 py-3 text-gray-600">{c.user?.name || c.user?.email}</td>
                <td className="px-4 py-3 text-gray-400 text-xs hidden sm:table-cell">{new Date(c.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => deleteComment(c.id)} className="text-xs text-red-500 hover:underline">{t('admin.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 20 && (
        <div className="flex justify-between mt-4 text-sm text-gray-500">
          <span>{(page-1)*20+1}-{Math.min(page*20, data.total)} of {data.total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
            <button onClick={() => setPage(p => p+1)} disabled={page*20 >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
