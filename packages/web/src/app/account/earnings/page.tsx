'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useTranslation from '../../../hooks/useTranslation';
import AccountNav from '../../components/AccountNav';

const yuan = (c: any) => ((Number(c) || 0) / 100).toFixed(2);

export default function EarningsPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [balance, setBalance] = useState<any>(null);
  const [wd, setWd] = useState<any>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem('token');
      if (!token) { router.push('/auth'); return; }
      try {
        const res = await fetch('/api/pay/me/balances', { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) { router.push('/auth'); return; }
        if (res.ok) {
          const data = await res.json();
          setBalance(data.balance);
          setWd(data.withdrawable || null);
          setTxns(data.transactions || []);
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bizLabel = (b: string) =>
    ({
      sale: t('pay.bizSale'),
      membership_share: t('pay.bizMemberShare'),
      refund_deduct: t('pay.bizRefund'),
      withdraw: t('pay.bizWithdraw'),
      adjust: t('pay.bizAdjust'),
    } as Record<string, string>)[b] || b;

  const cards = [
    { label: t('pay.withdrawable'), value: wd?.withdrawableCents, accent: 'text-brand-700' },
    { label: t('pay.settling'), value: wd?.frozenIncomeCents, accent: 'text-amber-600' },
    { label: t('pay.frozen'), value: balance?.frozen_cents, accent: 'text-blue-600' },
    { label: t('pay.totalEarned'), value: balance?.total_earned_cents, accent: 'text-neutral-900' },
    { label: t('pay.totalWithdrawn'), value: balance?.total_withdrawn_cents, accent: 'text-neutral-500' },
  ];

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <AccountNav />
      <h1 className="text-2xl font-bold mb-1">{t('pay.earningsTitle')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('pay.earningsDesc')}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
        {cards.map((c) => (
          <div key={c.label} className="p-4 rounded-xl border border-neutral-200 bg-white">
            <div className="text-xs text-neutral-500 mb-1">{c.label}</div>
            <div className={`text-lg font-bold ${c.accent}`}>¥{yuan(c.value)}</div>
          </div>
        ))}
      </div>

      <p className="text-xs text-neutral-400 mb-6">
        {t('pay.settlingTip').replace('{d}', String(wd?.settlementDelayDays ?? 7))}
      </p>

      <div className="mb-8">
        <Link
          href="/account/withdraw"
          className="inline-block px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700"
        >
          {t('pay.goWithdraw')}
        </Link>
      </div>

      <h2 className="text-lg font-semibold mb-3">{t('pay.txns')}</h2>
      {loading ? (
        <div className="py-10 text-center text-neutral-400">{t('pay.loading')}</div>
      ) : txns.length === 0 ? (
        <div className="py-10 text-center text-neutral-400">{t('pay.noTxns')}</div>
      ) : (
        <div className="overflow-x-auto border border-neutral-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colTime')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colReason')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('pay.colChange')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('pay.available')}</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((x) => (
                <tr key={x.id} className="border-t border-neutral-100">
                  <td className="px-4 py-3 text-xs text-neutral-500" suppressHydrationWarning>
                    {x.created_at ? new Date(x.created_at).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-3">
                    {bizLabel(x.biz_type)}
                    {x.remark && <span className="text-xs text-neutral-400 ml-1">{x.remark}</span>}
                  </td>
                  <td className={`px-4 py-3 text-right font-medium ${x.direction === 'in' ? 'text-red-600' : 'text-green-600'}`}>
                    {x.direction === 'in' ? '+' : '-'}¥{yuan(x.amount_cents)}
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-500">¥{yuan(x.balance_after_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
