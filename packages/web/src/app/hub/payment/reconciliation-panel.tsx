import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function ReconciliationPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    fetch('/api/admin/pay/reconciliation', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => setData(j))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  const stuck = data?.stuck || [];
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card label={t('admin.paidOrders')} value={data?.paidOrders} />
        <Card label={t('admin.deliveredOrders')} value={data?.deliveredOrders} />
        <Card label={t('admin.processedLogs')} value={data?.processedLogs} />
        <Card label={t('admin.stuckOrders')} value={data?.stuckCount} danger={(data?.stuckCount || 0) > 0} />
      </div>

      <h2 className="font-semibold text-neutral-800 mb-2">{t('admin.stuckOrders')}</h2>
      {stuck.length === 0 ? (
        <div className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg px-4 py-3">{t('admin.noStuck')}</div>
      ) : (
        <div className="bg-white border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-neutral-100">
              {stuck.map((s: any) => (
                <tr key={s.order_no}>
                  <td className="px-4 py-3 font-mono text-xs">{s.order_no}</td>
                  <td className="px-4 py-3 text-neutral-500">{new Date(s.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Card({ label, value, danger }: { label: string; value?: number; danger?: boolean }) {
  return (
    <div className="bg-white border rounded-xl px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${danger ? 'text-red-600' : 'text-neutral-900'}`}>{value ?? 0}</div>
    </div>
  );
}
