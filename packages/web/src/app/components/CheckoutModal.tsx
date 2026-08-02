'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import useTranslation from '../../hooks/useTranslation';

type Tab = 'skill' | 'membership';
type Plan = 'monthly' | 'quarterly' | 'yearly';

interface Pricing {
  pricing_mode: 'free' | 'paid' | 'subscription';
  price_cents: number;
  member_included: boolean;
}

interface Props {
  skillId?: string;
  skillName?: string;
  /** 402 拦截时后端回传的定价快照，可省一次请求 */
  initialPricing?: Pricing | null;
  initialTab?: Tab;
  onClose: () => void;
  /** 支付成功回调（用于自动重试下载 / 刷新会员状态） */
  onPaid: (tab: Tab) => void;
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

export default function CheckoutModal({
  skillId,
  skillName,
  initialPricing,
  initialTab,
  onClose,
  onPaid,
}: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab || (skillId ? 'skill' : 'membership'));
  const [plan, setPlan] = useState<Plan>('monthly');
  const [pricing, setPricing] = useState<Pricing | null>(initialPricing || null);
  const [prices, setPrices] = useState<Record<Plan, number>>({ monthly: 2900, quarterly: 7900, yearly: 26800 });
  const [loading, setLoading] = useState(true);
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

  // 载入定价
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (skillId) {
          const res = await fetch(`/api/pay/pricing/${skillId}`, { headers: authHeaders() });
          if (res.ok) {
            const data = await res.json();
            if (!alive) return;
            if (!initialPricing) setPricing(data.pricing);
            if (data.membership) setPrices(data.membership);
          }
        } else {
          const res = await fetch('/api/pay/membership-prices', { headers: authHeaders() });
          if (res.ok) {
            const data = await res.json();
            if (alive && data) setPrices(data);
          }
        }
      } catch {
        /* 静默：使用默认价格 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId]);

  useEffect(() => () => clearTimers(), []);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startPolling = useCallback(
    (no: string, forTab: Tab) => {
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
            setTimeout(() => onPaid(forTab), 1200);
          } else if (data.status === 'CLOSED') {
            clearTimers();
            setErr(t('pay.orderClosed'));
            setQr(null);
            setOrderNo(null);
          }
        } catch {
          /* 网络抖动忽略，下一轮继续 */
        }
      }, 3000);
    },
    [onPaid, t],
  );

  const createOrder = async () => {
    setErr(null);
    setCreating(true);
    try {
      const body: any = tab === 'skill' ? { type: 'skill', skillId, tradeType: 'NATIVE' } : { type: 'membership', plan, tradeType: 'NATIVE' };
      const res = await fetch('/api/pay/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
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
      startPolling(data.orderNo, tab);
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

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    resetOrder();
    setTab(next);
  };

  const amount = tab === 'skill' ? pricing?.price_cents || 0 : prices[plan];
  const mmss = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;

  const planLabel: Record<Plan, string> = {
    monthly: t('pay.planMonthly'),
    quarterly: t('pay.planQuarterly'),
    yearly: t('pay.planYearly'),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
          <h3 className="text-lg font-semibold">{t('pay.title')}</h3>
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
          <>
            {/* 选项卡 */}
            {skillId && (
              <div className="flex gap-2 px-6 pt-4">
                <button
                  onClick={() => switchTab('skill')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border ${
                    tab === 'skill'
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {t('pay.tabSingle')}
                </button>
                <button
                  onClick={() => switchTab('membership')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border ${
                    tab === 'membership'
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {t('pay.tabMember')}
                  {pricing?.member_included && (
                    <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">
                      {t('pay.included')}
                    </span>
                  )}
                </button>
              </div>
            )}

            <div className="px-6 py-5">
              {loading ? (
                <div className="py-10 text-center text-sm text-neutral-400">{t('pay.loading')}</div>
              ) : (
                <>
                  {/* 商品信息 */}
                  {tab === 'skill' ? (
                    <div className="mb-4">
                      <div className="text-sm text-neutral-500 mb-1">{t('pay.subject')}</div>
                      <div className="font-medium truncate">{skillName || t('pay.skillDefault')}</div>
                      {pricing?.member_included && (
                        <div className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                          {t('pay.memberTip')}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mb-4 space-y-2">
                      {(['monthly', 'quarterly', 'yearly'] as Plan[]).map((p) => (
                        <button
                          key={p}
                          onClick={() => {
                            resetOrder();
                            setPlan(p);
                          }}
                          className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left ${
                            plan === p
                              ? 'border-brand-600 bg-brand-50'
                              : 'border-neutral-200 hover:bg-neutral-50'
                          }`}
                        >
                          <span className="text-sm font-medium">{planLabel[p]}</span>
                          <span className="text-sm font-semibold text-brand-700">¥{yuan(prices[p])}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 金额 */}
                  <div className="flex items-baseline justify-between mb-4">
                    <span className="text-sm text-neutral-500">{t('pay.amount')}</span>
                    <span className="text-2xl font-bold text-brand-700">¥{yuan(amount)}</span>
                  </div>

                  {err && (
                    <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 break-all">{err}</div>
                  )}

                  {/* 二维码 / 下单按钮 */}
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
                      disabled={creating || (tab === 'skill' && !amount)}
                      className="w-full py-3 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-50"
                    >
                      {creating ? t('pay.creating') : t('pay.payNow')}
                    </button>
                  )}

                  <p className="mt-4 text-[11px] leading-relaxed text-neutral-400 text-center">
                    {t('pay.legal')}
                  </p>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
