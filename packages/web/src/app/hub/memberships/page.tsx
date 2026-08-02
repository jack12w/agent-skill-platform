'use client';

import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubMembershipsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: '20' });
    if (status) p.set('status', status);
    try {
      const r = await fetch(`/api/admin/pay/memberships?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      setData(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [page, status]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.memberships')}</h1>
      <div className="flex items-center gap-3 mb-4">
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="px-3 py-1.5 text-sm border rounded-lg">
          <option value="">{t('admin.allStatus')}</option>
          <option value="active">active</option>
          <option value="expired">expired</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">订阅用户</th>
              <th className="px-4 py-3 text-left">创作者</th>
              <th className="px-4 py-3 text-left">{t('admin.thPlan')}</th>
              <th className="px-4 py-3 text-right">金额</th>
              <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
              <th className="px-4 py-3 text-left">开始</th>
              <th className="px-4 py-3 text-left">到期</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((m: any) => (
              <tr key={m.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3">{m.subscriber_name}</td>
                <td className="px-4 py-3">{m.target_type === 'team' ? `团队：${m.target_name}` : m.target_name}</td>
                <td className="px-4 py-3">{m.plan}</td>
                <td className="px-4 py-3 text-right">¥{((m.price_cents || 0) / 100).toFixed(2)}</td>
                <td className="px-4 py-3 text-center"><span className="px-2 py-0.5 rounded-full text-xs bg-neutral-100 text-neutral-600">{m.status}</span></td>
                <td className="px-4 py-3 text-neutral-500">{new Date(m.started_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-neutral-500">{new Date(m.expires_at).toLocaleDateString()}</td>
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
