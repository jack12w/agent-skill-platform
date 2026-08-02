'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }
function yuan(c: number) { return ((c || 0) / 100).toFixed(2); }

export default function HubSettlementsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState('');
  const [msg, setMsg] = useState('');

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: '20' });
    try {
      const r = await fetch(`/api/admin/pay/settlements?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      setData(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const run = async () => {
    const token = getToken(); if (!token) return;
    if (!/^\d{4}-\d{2}$/.test(period)) { setMsg('账期格式应为 YYYY-MM'); return; }
    setMsg('');
    try {
      const r = await fetch(`/api/admin/pay/settlements/run?period=${period}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      setMsg(`${t('admin.settlementExecuted')} 平台 ¥${yuan(j.platform_cents)} / 创作者 ¥${yuan(j.creator_cents)}`);
    } catch (e: any) { setMsg(e?.message || '失败'); }
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.settlements')}</h1>
      <div className="flex items-center gap-3 mb-4">
        <input type="month" value={period} onChange={e => setPeriod(e.target.value)} className="px-3 py-1.5 text-sm border rounded-lg" />
        <button onClick={run} className="px-3 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700">{t('admin.runSettlement')}</button>
        {msg && <span className="text-xs text-green-600">{msg}</span>}
      </div>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">{t('admin.thPeriod')}</th>
              <th className="px-4 py-3 text-left">类型</th>
              <th className="px-4 py-3 text-right">总额</th>
              <th className="px-4 py-3 text-right">平台</th>
              <th className="px-4 py-3 text-right">创作者</th>
              <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((s: any) => (
              <tr key={s.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3">{s.period}</td>
                <td className="px-4 py-3">{s.type}</td>
                <td className="px-4 py-3 text-right">¥{yuan(s.total_cents)}</td>
                <td className="px-4 py-3 text-right">¥{yuan(s.platform_cents)}</td>
                <td className="px-4 py-3 text-right">¥{yuan(s.creator_cents)}</td>
                <td className="px-4 py-3 text-center"><span className="px-2 py-0.5 rounded-full text-xs bg-neutral-100 text-neutral-600">{s.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.size && (
        <div className="flex justify-between mt-4 text-sm text-neutral-500">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * data.size >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
        </div>
      )}
    </div>
  );
}
