'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import useTranslation from '../../hooks/useTranslation';

interface Props {
  pluginId: string;
  pluginName?: string;
  /** 月价（分） */
  priceCents: number;
  onClose: () => void;
  /** 支付成功回调 */
  onPaid: () => void;
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

export default function PluginCheckoutModal({
  pluginId,
  pluginName,
  priceCents,
  onClose,
  onPaid,
}: Props) {
  const { t } = useTranslation();
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
            setTimeout(() => onPaid(), 1200);
          } else if (data.status === 'CLOSED') {
            clearTimers();
            setErr(t('pay.orderClosed') || '订单已关闭');
            setQr(null);
            setOrderNo(null);
          }
        } catch {
          /* 网络抖动忽略 */
        }
      }, 3000);
    },
    [onPaid, t],
  );

  const createOrder = async () => {
    setErr(null);
    setCreating(true);
    try {
      const body: any = { type: 'plugin', pluginId, tradeType: 'NATIVE' };
      const res = await fetch('/api/pay/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        setErr(t('pay.loginExpired') || '请先登录');
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
        setErr(t('pay.noQr') || '未获取到支付二维码');
      }
      startPolling(data.orderNo);
    } catch (e: any) {
      setErr(e.message || t('pay.createFail') || '创建订单失败');
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

  const amount = priceCents || 0;
  const mmss = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
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
          <div className="px-6 py-5">
            <div className="mb-4">
              <div className="text-sm text-neutral-500 mb-1">{t('pay.subject')}</div>
              <div className="font-medium truncate">{pluginName || t('plugins.title')}</div>
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
                <img
                  src={qr}
                  alt="WeChat Pay QR"
                  className="mx-auto w-[220px] h-[220px] rounded-lg border border-neutral-100"
                />
                <div className="mt-2 text-sm text-neutral-600">{t('pay.scanHint')}</div>
                <div className="mt-1 text-xs text-neutral-400">
                  {t('pay.expireIn')} {mmss}
                  {orderNo ? ` · ${orderNo}` : ''}
                </div>
                <button
                  onClick={resetOrder}
                  className="mt-3 text-xs text-neutral-500 hover:text-brand-600 underline"
                >
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

            <p className="mt-4 text-[11px] leading-relaxed text-neutral-400 text-center">
              {t('pay.legal')}{' '}
              <a href="/agreement" target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:underline">
                {t('agreement.viewTerms')}
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
