'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubReviewsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const r = await fetch(`/api/admin/reviews?page=${page}&size=20`, { headers: { Authorization: `Bearer ${token}` } });
    setData(await r.json());
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const review = async (id: string, action: 'approve' | 'reject') => {
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/reviews/${id}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-1">{t('admin.reviews')}</h1>
      <p className="text-xs text-neutral-500 mb-4">{t('admin.reviewDesc')}</p>

      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">{t('admin.thSkill')}</th>
              <th className="px-4 py-3 text-left hidden md:table-cell">{t('admin.thSubmitter')}</th>
              <th className="px-4 py-3 text-left hidden lg:table-cell">{t('admin.thTags')}</th>
              <th className="px-4 py-3 text-left hidden sm:table-cell">{t('admin.thUpdated')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thAction')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((s: any) => (
              <tr key={s.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3">
                  <a href={`/skills/${s.slug}`} target="_blank" className="font-medium text-brand-600 hover:underline">{s.name}</a>
                  {s.short_summary && <div className="text-xs text-neutral-400 mt-0.5 truncate max-w-xs">{s.short_summary}</div>}
                </td>
                <td className="px-4 py-3 text-neutral-600 hidden md:table-cell">{s.owner_user?.name || s.owner_user?.email}</td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {(s.tags || []).slice(0, 3).map((t: string) => <span key={t} className={`px-1.5 py-0.5 rounded text-xs ${t === '精选' ? 'bg-orange-50 text-orange-800 border border-orange-200' : 'bg-yellow-50 text-yellow-700'}`}>{t}</span>)}
                  </div>
                </td>
                <td className="px-4 py-3 text-neutral-400 text-xs hidden sm:table-cell whitespace-nowrap">{new Date(s.updated_at || s.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => review(s.id, 'approve')} className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">{t('admin.approve')}</button>
                    <button onClick={() => { if (confirm(t('admin.rejectConfirm'))) review(s.id, 'reject'); }} className="px-3 py-1.5 text-xs bg-red-500 text-white rounded-lg hover:bg-red-600">{t('admin.reject')}</button>
                  </div>
                </td>
              </tr>
            ))}
            {(!data || data.items.length === 0) && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-neutral-400 text-sm">{t('admin.noPending')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > 20 && (
        <div className="flex justify-between mt-4 text-sm text-neutral-500">
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
