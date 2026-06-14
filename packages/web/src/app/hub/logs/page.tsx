'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubLogsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/logs?page=${page}&size=30`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setData(j);
      setErr('');
    } catch (e: any) {
      setErr(e.message || 'Failed to load');
    }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;
  if (err) return <div className="text-center py-16 text-neutral-400 text-sm">{err} — {t('admin.logTableHint')}</div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.logs')}</h1>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr><th className="px-4 py-3 text-left">{t('admin.thTime')}</th><th className="px-4 py-3 text-left">{t('admin.thAction')}</th><th className="px-4 py-3 text-left">{t('admin.thTarget')}</th><th className="px-4 py-3 text-left hidden md:table-cell">{t('admin.thDetail')}</th></tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((l: any) => (
              <tr key={l.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3 text-neutral-400 text-xs whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-4 py-3"><span className="px-2 py-0.5 bg-brand-50 text-brand-700 rounded text-xs font-medium">{l.action}</span></td>
                <td className="px-4 py-3 text-neutral-500 text-xs">{l.target_type}{l.target_id ? `:${l.target_id.slice(0,12)}` : ''}</td>
                <td className="px-4 py-3 text-neutral-400 text-xs hidden md:table-cell">{l.detail || '-'}</td>
              </tr>
            ))}
            {(!data || data.items.length === 0) && (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-neutral-400 text-sm">No logs yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.total > 30 && (
        <div className="flex justify-between mt-4 text-sm text-neutral-500">
          <span>{(page-1)*30+1}-{Math.min(page*30, data.total)} of {data.total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
            <button onClick={() => setPage(p => p+1)} disabled={page*30 >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
