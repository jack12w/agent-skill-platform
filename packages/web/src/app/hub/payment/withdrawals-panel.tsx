import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }
function yuan(c: number) { return ((c || 0) / 100).toFixed(2); }

export default function WithdrawalsPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState('');

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: '20' });
    if (status) p.set('status', status);
    try {
      const r = await fetch(`/api/admin/pay/withdrawals?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      setData(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [page, status]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const approve = async (id: string) => {
    const token = getToken(); if (!token) return;
    setMsg('');
    try {
      const r = await fetch(`/api/admin/pay/withdrawals/${id}/approve`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      setMsg(
        j.status === 'PAID' ? '已打款'
        : j.status === 'FAILED' ? `打款失败:${j.fail_reason || ''}`
        : j.status === 'PROCESSING' ? '已受理，打款中（等待微信确认）'
        : (j.message || j.status),
      );
    } catch (e: any) { setMsg(e?.message || '操作失败'); }
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="px-3 py-1.5 text-sm border rounded-lg">
          <option value="">{t('admin.allStatus')}</option>
          <option value="PENDING">PENDING</option>
          <option value="REVIEWING">REVIEWING</option>
          <option value="PROCESSING">PROCESSING</option>
          <option value="PAID">PAID</option>
          <option value="FAILED">FAILED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        {msg && <span className="text-xs text-green-600">{msg}</span>}
      </div>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">{t('admin.thSeller')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thAmount')}</th>
              <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
              <th className="px-4 py-3 text-left">{t('admin.thApplyTime')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((w: any) => (
              <tr key={w.id} className="hover:bg-neutral-100">
                <td className="px-4 py-3 font-mono text-xs">{w.user_id}</td>
                <td className="px-4 py-3 text-right font-medium">¥{yuan(w.amount_cents)}</td>
                <td className="px-4 py-3 text-center"><span className="px-2 py-0.5 rounded-full text-xs bg-neutral-100 text-neutral-600">{w.status}</span></td>
                <td className="px-4 py-3 text-neutral-500">{new Date(w.applied_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  {w.status === 'PENDING' && (
                    <button onClick={() => approve(w.id)} className="text-xs px-3 py-1 bg-brand-600 text-white rounded hover:bg-brand-700">
                      {t('admin.approveWithdraw')}
                    </button>
                  )}
                </td>
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
