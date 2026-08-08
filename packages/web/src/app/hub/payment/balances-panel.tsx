import { useEffect, useState, useCallback } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }
function yuan(c: number) { return ((c || 0) / 100).toFixed(2); }

export default function BalancesPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: '20' });
    try {
      const r = await fetch(`/api/admin/pay/creators?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      setData(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">{t('admin.thSeller')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thAvailable')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thFrozen')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thTotalEarned')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thTotalWithdrawn')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((b: any) => (
              <tr key={b.user_id} className="hover:bg-neutral-100">
                <td className="px-4 py-3"><div className="font-medium">{b.name || '-'}</div><div className="text-xs text-neutral-400">{b.email}</div></td>
                <td className="px-4 py-3 text-right font-medium text-green-600">¥{yuan(b.available_cents)}</td>
                <td className="px-4 py-3 text-right text-neutral-500">¥{yuan(b.frozen_cents)}</td>
                <td className="px-4 py-3 text-right">¥{yuan(b.total_earned_cents)}</td>
                <td className="px-4 py-3 text-right">¥{yuan(b.total_withdrawn_cents)}</td>
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
