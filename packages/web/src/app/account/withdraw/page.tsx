'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useTranslation from '../../../hooks/useTranslation';
import AccountNav from '../../components/AccountNav';

const yuan = (c: any) => ((Number(c) || 0) / 100).toFixed(2);

export default function WithdrawPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [balance, setBalance] = useState<any>(null);
  const [minCents, setMinCents] = useState(1000);
  const [wechatBound, setWechatBound] = useState(true);
  const [records, setRecords] = useState<any[]>([]);
  const [amount, setAmount] = useState('');
  const [realName, setRealName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/auth'); return; }
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const [b, w] = await Promise.all([
        fetch('/api/pay/me/balances', { headers }),
        fetch('/api/pay/me/withdrawals', { headers }),
      ]);
      if (b.status === 401) { router.push('/auth'); return; }
      if (b.ok) {
        const data = await b.json();
        setBalance(data.balance);
        if (data.withdrawMinCents) setMinCents(Number(data.withdrawMinCents));
        setWechatBound(!!data.wechatBound);
      }
      if (w.ok) setRecords(await w.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const submit = async () => {
    setMsg(null);
    const cents = Math.round(parseFloat(amount || '0') * 100);
    if (!cents || cents <= 0) return;
    setSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/pay/withdrawals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountCents: cents, realName: realName || undefined }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      setMsg({ type: 'ok', text: t('pay.withdrawOk') });
      setAmount('');
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message || 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const wdLabel = (s: string) =>
    ({
      PENDING: t('pay.wdPending'),
      REVIEWING: t('pay.wdProcessing'),
      PAID: t('pay.wdSuccess'),
      FAILED: t('pay.wdFailed'),
      CANCELLED: t('pay.stClosed'),
    } as Record<string, string>)[s] || s;

  const wdClass = (s: string) =>
    ({
      PENDING: 'bg-amber-100 text-amber-700',
      REVIEWING: 'bg-blue-100 text-blue-700',
      PAID: 'bg-green-100 text-green-700',
      FAILED: 'bg-red-100 text-red-700',
      CANCELLED: 'bg-neutral-200 text-neutral-600',
    } as Record<string, string>)[s] || 'bg-neutral-100 text-neutral-600';

  const available = Number(balance?.available_cents || 0);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <AccountNav />
      <h1 className="text-2xl font-bold mb-1">{t('pay.withdrawTitle')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('pay.withdrawDesc')}</p>

      {!wechatBound && (
        <div className="mb-5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          {t('pay.bindWechatFirst')}
        </div>
      )}

      <div className="p-5 rounded-xl border border-neutral-200 bg-white mb-8">
        <div className="text-xs text-neutral-500 mb-4">
          {t('pay.minTip').replace('{n}', String(minCents / 100)).replace('{bal}', yuan(available))}
        </div>

        <label className="block text-sm font-medium mb-1">{t('pay.withdrawAmount')}</label>
        <input
          type="number"
          min={minCents / 100}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={(minCents / 100).toFixed(2)}
          className="w-full px-3 py-2 border border-neutral-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />

        <label className="block text-sm font-medium mb-1">{t('pay.realName')}</label>
        <input
          type="text"
          value={realName}
          onChange={(e) => setRealName(e.target.value)}
          className="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
        <div className="text-xs text-neutral-400 mt-1 mb-4">{t('pay.realNameHint')}</div>

        {msg && (
          <div
            className={`mb-4 text-sm rounded-lg px-3 py-2 ${
              msg.type === 'ok' ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'
            }`}
          >
            {msg.text}
          </div>
        )}

        <button
          onClick={submit}
          disabled={submitting || !wechatBound || !amount || available < minCents}
          className="w-full py-2.5 rounded-lg bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-50"
        >
          {submitting ? t('pay.submitting') : t('pay.submitWithdraw')}
        </button>
      </div>

      <h2 className="text-lg font-semibold mb-3">{t('pay.withdrawRecords')}</h2>
      {loading ? (
        <div className="py-10 text-center text-neutral-400">{t('pay.loading')}</div>
      ) : records.length === 0 ? (
        <div className="py-10 text-center text-neutral-400">{t('pay.noWithdrawals')}</div>
      ) : (
        <div className="overflow-x-auto border border-neutral-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colTime')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('pay.colAmount')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('pay.colReason')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-t border-neutral-100">
                  <td className="px-4 py-3 text-xs text-neutral-500" suppressHydrationWarning>
                    {r.applied_at ? new Date(r.applied_at).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">¥{yuan(r.amount_cents)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${wdClass(r.status)}`}>{wdLabel(r.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-500">{r.fail_reason || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
