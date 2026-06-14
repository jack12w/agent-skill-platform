'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubFeedbacksPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const r = await fetch(`/api/admin/feedbacks?page=${page}&size=20`, { headers: { Authorization: `Bearer ${token}` } });
    setData(await r.json());
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const deleteFeedback = async (id: string) => {
    if (!confirm('Delete this feedback?')) return;
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/feedbacks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchData();
  };

  const typeLabel = (v: string) => v === 'bug' ? t('help.fbBug') : v === 'suggestion' ? t('help.fbSuggestion') : t('help.fbOther');
  const typeColor = (v: string) => v === 'bug' ? 'bg-red-50 text-red-600' : v === 'suggestion' ? 'bg-brand-50 text-brand-600' : 'bg-neutral-100 text-neutral-600';

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-1">{t('help.fbAdminTitle')}</h1>
      <p className="text-xs text-neutral-500 mb-4">{t('help.fbAdminDesc')}</p>

      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">{t('help.fbAdminType')}</th>
              <th className="px-4 py-3 text-left">{t('help.fbAdminName')}</th>
              <th className="px-4 py-3 text-left hidden md:table-cell">{t('help.fbAdminEmail')}</th>
              <th className="px-4 py-3 text-left">{t('help.fbAdminContent')}</th>
              <th className="px-4 py-3 text-left hidden sm:table-cell">{t('help.fbAdminDate')}</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((f: any) => (
              <tr key={f.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${typeColor(f.type)}`}>
                    {typeLabel(f.type)}
                  </span>
                </td>
                <td className="px-4 py-3 font-medium text-neutral-800">{f.name}</td>
                <td className="px-4 py-3 text-neutral-500 hidden md:table-cell">{f.email || '-'}</td>
                <td className="px-4 py-3 text-neutral-600 max-w-sm truncate">{f.content}</td>
                <td className="px-4 py-3 text-neutral-400 text-xs hidden sm:table-cell whitespace-nowrap">{new Date(f.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => deleteFeedback(f.id)} className="text-xs text-danger-500 hover:underline">{t('help.fbAdminDelete')}</button>
                </td>
              </tr>
            ))}
            {(!data || data.items.length === 0) && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-neutral-400 text-sm">{t('help.fbAdminEmpty')}</td></tr>
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
