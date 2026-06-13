'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubLogsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const r = await fetch(`/api/admin/logs?page=${page}&size=30`, { headers: { Authorization: `Bearer ${token}` } });
    setData(await r.json());
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-4">{t('admin.logs')}</h1>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th className="px-4 py-3 text-left">Time</th><th className="px-4 py-3 text-left">Action</th><th className="px-4 py-3 text-left">Target</th><th className="px-4 py-3 text-left hidden md:table-cell">Detail</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.items || []).map((l: any) => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-4 py-3"><span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">{l.action}</span></td>
                <td className="px-4 py-3 text-gray-500 text-xs">{l.target_type}{l.target_id ? `:${l.target_id.slice(0,12)}` : ''}</td>
                <td className="px-4 py-3 text-gray-400 text-xs hidden md:table-cell">{l.detail || '-'}</td>
              </tr>
            ))}
            {(!data || data.items.length === 0) && (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400 text-sm">No logs yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.total > 30 && (
        <div className="flex justify-between mt-4 text-sm text-gray-500">
          <span>{(page-1)*30+1}-{Math.min(page*30, data.total)} of {data.total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1} className="px-3 py-1 border rounded disabled:opacity-30">Prev</button>
            <button onClick={() => setPage(p => p+1)} disabled={page*30 >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
