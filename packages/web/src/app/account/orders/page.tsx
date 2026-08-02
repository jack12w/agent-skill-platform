'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useTranslation from '../../../hooks/useTranslation';
import AccountNav from '../../components/AccountNav';

const yuan = (c: any) => ((Number(c) || 0) / 100).toFixed(2);

export default function MyOrdersPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/auth'); return; }
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const o = await fetch('/api/pay/me/orders', { headers });
      if (o.status === 401) { router.push('/auth'); return; }
      if (o.ok) setOrders(await o.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const statusLabel = (s: string) =>
    ({
      PENDING_PAY: t('pay.stPendingPay'),
      PAID: t('pay.stPaid'),
      DELIVERED: t('pay.stDelivered'),
      CLOSED: t('pay.stClosed'),
      REFUNDED: t('pay.stRefunded'),
      PARTIAL_REFUNDED: t('pay.stPartialRefunded'),
    } as Record<string, string>)[s] || s;

  const statusClass = (s: string) =>
    ({
      PENDING_PAY: 'bg-amber-100 text-amber-700',
      PAID: 'bg-blue-100 text-blue-700',
      DELIVERED: 'bg-green-100 text-green-700',
      CLOSED: 'bg-neutral-200 text-neutral-600',
      REFUNDED: 'bg-red-100 text-red-700',
      PARTIAL_REFUNDED: 'bg-orange-100 text-orange-700',
    } as Record<string, string>)[s] || 'bg-neutral-100 text-neutral-600';

  const typeLabel = (tp: string) =>
    ({
      skill: t('pay.typeSkill'),
      membership: t('pay.typeMembership'),
      creator_membership: t('pay.typeCreatorMembership'),
    } as Record<string, string>)[tp] || tp;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <AccountNav />
      <h1 className="text-2xl font-bold mb-1">{t('pay.ordersTitle')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('pay.ordersDesc')}</p>

      {loading ? (
        <div className="py-12 text-center text-neutral-400">{t('pay.loading')}</div>
      ) : orders.length === 0 ? (
        <div className="py-12 text-center text-neutral-400">{t('pay.noOrders')}</div>
      ) : (
        <div className="overflow-x-auto border border-neutral-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colOrderNo')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colType')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('pay.colAmount')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colTime')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-neutral-100">
                  <td className="px-4 py-3 font-mono text-xs">{o.order_no}</td>
                  <td className="px-4 py-3">{typeLabel(o.type)}</td>
                  <td className="px-4 py-3 text-right font-medium">¥{yuan(o.total_cents)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${statusClass(o.status)}`}>{statusLabel(o.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-500 text-xs" suppressHydrationWarning>
                    {o.created_at ? new Date(o.created_at).toLocaleString() : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
