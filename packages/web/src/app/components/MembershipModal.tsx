'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import useTranslation from '../../hooks/useTranslation';

type Plan = 'monthly' | 'quarterly' | 'yearly';

interface Props {
  targetType: 'user' | 'team';
  targetId: string;
  targetName?: string;
  onClose: () => void;
  onPaid: (targetType: string, targetId: string) => void;
}

const yuan = (cents?: number | null) => ((Number(cents) || 0) / 100).toFixed(2);

function authHeaders(): Record<string, string> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export default function MembershipModal({ targetType, targetId, targetName, onClose, onPaid }: Props) {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<Record<Plan, number> | null>(null);
  const [hasPlan, setHasPlan] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mySub, setMySub] = useState<any>(null);
  const [plan, setPlan] = useState<Plan>('monthly');
  const [creating, setCreating] = useState(false);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);

  const timerRef = useRef<any>(null);
  const tickRef = useRef<any>(null);

  const clearTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    timerRef.current = null;
    tickRef.current = null;
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [planRes, subRes] = await Promise.all([
          fetch(`/api/pay/membership/plan?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`, { headers: authHeaders() }),
          fetch(`/api/pay/membership/subscribe/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`, { headers: authHeaders() }),
        ]);
        if (!alive) return;
        if (planRes.ok) {
          const p = await planRes.json();
          setHasPlan(!!p.hasPlan);
          setPlans(p.plans || null);
        }
        if (subRes.ok) {
          const s = await subRes.json();
          if (s.subscribed) setMySub(s);
        }
      } catch {
        /* ignore */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [targetType, targetId]);

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startPolling = useCallback(
    (no: string) => {
      clearTimers();
      setLeft(15 * 60);
      tickRef.current = setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000);
      timerRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/pay/orders/${no}/status`, { headers: authHeaders() });
          if (!res.ok) return;
          const data = await res.json();
          if (data.status === 'PAID' || data.status === 'DELIVERED') {
            clearTimers();
            setPaid(true);
            setTimeout(() => onPaid(targetType, targetId), 1200);
          } else if (data.status === 'CLOSED') {
            clearTimers();
            setErr(t('pay.orderClosed'));
            setQr(null);
            setOrderNo(null);
          }
        } catch {
          /* ignore */
        }
      }, 3000);
    },
    [onPaid, targetType, targetId, t],
  );

  const createOrder = async () => {
    if (!plans || !plans[plan]) {
      setErr(t('member.empty'));
      return;
    }
    setErr(null);
    setCreating(true);
    try {
      const res = await fetch('/api/pay/membership/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ targetType, targetId, plan, tradeType: 'NATIVE' }),
      });
      if (res.status === 401) {
        setErr(t('pay.loginExpired'));
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setOrderNo(data.orderNo);
      const codeUrl = data?.pay?.code_url;
      if (codeUrl) {
        const dataUrl = await QRCode.toDataURL(codeUrl, { width: 220, margin: 1 });
        setQr(dataUrl);
      } else if (data?.pay?.h5_url) {
        window.location.href = data.pay.h5_url;
        return;
      } else {
        setErr(t('pay.noQr'));
      }
      startPolling(data.orderNo);
    } catch (e: any) {
      setErr(e.message || t('pay.createFail'));
    } finally {
      setCreating(false);
    }
  };

  const resetOrder = () => {
    clearTimers();
    setOrderNo(null);
    setQr(null);
    setErr(null);
  };

  const planLabel: Record<Plan, string> = {
    monthly: t('pay.planMonthly'),
    quarterly: t('pay.planQuarterly'),
    yearly: t('pay.planYearly'),
  };
  const amount = plans ? plans[plan] : 0;
  const mmss = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
          <h3 className="text-lg font-semibold">
            {t('member.title')}
            {targetName ? <span className="ml-1 text-brand-600">{targetName}</span> : null}
          </h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700 text-xl leading-none">
            ×
          </button>
        </div>

        {paid ? (
          <div className="px-6 py-12 text-center">
            <div className="text-5xl mb-3">✅</div>
            <div className="text-lg font-semibold mb-1">{t('pay.paidTitle')}</div>
            <p className="text-sm text-neutral-500">{t('pay.paidHint')}</p>
          </div>
        ) : (
          <div className="px-6 py-5">
            {loading ? (
              <div className="py-10 text-center text-sm text-neutral-400">{t('pay.loading')}</div>
            ) : !hasPlan || !plans ? (
              <div className="py-10 text-center text-sm text-neutral-500">
                <div className="text-4xl mb-3">🔒</div>
                {t('member.empty')}
              </div>
            ) : (
              <>
                {mySub?.subscribed && (
                  <div className="mb-4 text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">
                    {t('member.alreadySub')}：{planLabel[mySub.plan as Plan] ?? mySub.plan} ·{' '}
                    {new Date(mySub.expires_at).toLocaleDateString()}
                  </div>
                )}
                <div className="mb-4 space-y-2">
                  {(['monthly', 'quarterly', 'yearly'] as Plan[]).map((p) => {
                    const disabled = !plans[p];
                    return (
                      <button
                        key={p}
                        disabled={disabled}
                        onClick={() => {
                          resetOrder();
                          setPlan(p);
                        }}
                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left ${
                          disabled
                            ? 'border-neutral-100 text-neutral-300 cursor-not-allowed'
                            : plan === p
                            ? 'border-brand-600 bg-brand-50'
                            : 'border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        <span className="text-sm font-medium">{planLabel[p]}</span>
                        <span className={`text-sm font-semibold ${disabled ? 'text-neutral-300' : 'text-brand-700'}`}>
                          {disabled ? '—' : `¥${yuan(plans[p])}`}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-baseline justify-between mb-4">
                  <span className="text-sm text-neutral-500">{t('pay.amount')}</span>
                  <span className="text-2xl font-bold text-brand-700">¥{yuan(amount)}</span>
                </div>

                {err && (
                  <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 break-all">{err}</div>
                )}

                {qr ? (
                  <div className="text-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qr} alt="WeChat Pay QR" className="mx-auto w-[220px] h-[220px] rounded-lg border border-neutral-100" />
                    <div className="mt-2 text-sm text-neutral-600">{t('pay.scanHint')}</div>
                    <div className="mt-1 text-xs text-neutral-400">
                      {t('pay.expireIn')} {mmss}
                      {orderNo ? ` · ${orderNo}` : ''}
                    </div>
                    <button onClick={resetOrder} className="mt-3 text-xs text-neutral-500 hover:text-brand-600 underline">
                      {t('pay.refreshQr')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={createOrder}
                    disabled={creating || !amount}
                    className="w-full py-3 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-50"
                  >
                    {creating ? t('pay.creating') : t('pay.payNow')}
                  </button>
                )}

                <p className="mt-4 text-[11px] leading-relaxed text-neutral-400 text-center">{t('pay.legal')}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
