'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import useTranslation from '../../hooks/useTranslation';
import Modal from './Modal';

/** 档位下拉选项（同系列多档商品，如 个人版/企业版） */
export interface CheckoutOption {
  id: string;
  name: string;
  priceCents: number;
  listCents?: number;
}

interface Props {
  pluginId: string;
  pluginName?: string;
  /** 实付月价（分） */
  priceCents: number;
  /** 划线原价（分）；促销中才传，其余情况留空 */
  listCents?: number;
  /** 可选：传入且 >1 条时，「购买内容」变为档位下拉框；不传保持原样 */
  options?: CheckoutOption[];
  /** 打开时默认选中的商品 id；不传或不在 options 里则用 pluginId */
  defaultOptionId?: string;
  /**
   * true = 没有可信的默认档位时**不静默兜底**，强制用户手动选一档。
   * 授权页续费用：历史档位解析不到就兜到 ¥49/月主插件会让年付用户按月付下单。
   */
  requireChoice?: boolean;
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
  listCents,
  options,
  defaultOptionId,
  requireChoice,
  onClose,
  onPaid,
}: Props) {
  const { t } = useTranslation();
  /* ── 档位下拉（2026-10-09）：仅当调用方传入 >1 条 options 时启用。
     选中态只影响「展示的名称/价格」与下单 pluginId；未传 options 的调用方
     （account/plugins 续费页）行为完全不变。 ── */
  const opts = options && options.length > 1 ? options : null;
  const [selectedId, setSelectedId] = useState<string>(
    opts && defaultOptionId && opts.some((o) => o.id === defaultOptionId)
      ? defaultOptionId
      : opts && requireChoice
        ? ''
        : pluginId,
  );
  /**
   * requireChoice 且未选档时为 null：金额显示「—」，支付按钮禁用，不允许下空单。
   * ⚠️ 其余情况必须保留原来的 opts[0] 兜底 —— 市场页/账号页共用本弹窗，
   *    选中 id 不在 options 里时静默禁用支付就是回归（2026-11-14 复核修正）。
   */
  const sel: CheckoutOption | null =
    opts?.find((o) => o.id === selectedId) ??
    (opts
      ? requireChoice && !selectedId
        ? null
        : opts[0]
      : { id: pluginId, name: pluginName ?? '', priceCents, listCents });

  const [creating, setCreating] = useState(false);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  /**
   * 服务端实付价与展示价不一致时（典型：本页停留期间促销刚好结束），
   * 记下服务端返回的最新价；按 pluginId 绑定，切档自动失效。
   * 绝不按未确认的价格展示二维码。
   */
  const [pricePatch, setPricePatch] = useState<{
    id: string;
    priceCents: number;
    listCents?: number;
  } | null>(null);

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
    // 未选档（requireChoice）时不允许下单：sel 为 null 会拿到空 pluginId
    if (!sel) return;
    setErr(null);
    setCreating(true);
    try {
      const body: any = { type: 'plugin', pluginId: sel.id, tradeType: 'NATIVE' };
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
      /**
       * 服务端金额二次校验（2026-11-15）：
       * 展示价来自页面打开时的快照，促销可能在停留期间结束 —— 服务端 `createOrder`
       * 永远按当下实价建单。两者不一致时**绝不展示二维码**（微信侧金额已不可改），
       * 更新展示价并提示用户确认后重付；订单 15 分钟自动关闭，无资损。
       */
      const serverTotal = Number(data?.totalCents);
      if (
        sel &&
        Number.isFinite(serverTotal) &&
        serverTotal > 0 &&
        serverTotal !== amount
      ) {
        setPricePatch({
          id: sel.id,
          priceCents: serverTotal,
          listCents: sel.listCents,
        });
        setOrderNo(null);
        setQr(null);
        setErr(t('pay.priceUpdated', { amount: yuan(serverTotal) }));
        return;
      }
      /**
       * 校验通过时**不要**清空 pricePatch：props 里的价是页面打开时的快照，
       * 清空会让金额回落到旧值（实测：服务端 ¥399，界面又显示 ¥49 并出码）。
       * patch 按 pluginId 绑定，切档自然失效；弹窗关闭即随组件卸载销毁。
       */
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

  /** 服务端校验过的最新价优先于 props（props 是页面打开时的快照） */
  const shown = pricePatch && sel && pricePatch.id === sel.id ? pricePatch : null;
  const amount = (shown ? shown.priceCents : sel?.priceCents) || 0;
  const shownList = shown ? shown.listCents : sel?.listCents;
  const mmss = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden">
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
              {opts ? (
                <select
                  className="w-full px-3 py-2 text-sm font-medium text-neutral-900 border border-neutral-200 rounded-lg bg-white focus:outline-none focus:border-brand-400"
                  value={sel?.id ?? ''}
                  onChange={(e) => {
                    // 切档即作废未支付订单（二维码/倒计时都对应旧 pluginId）
                    setSelectedId(e.target.value);
                    resetOrder();
                  }}
                >
                  {requireChoice && (
                    <option value="" disabled>
                      {t('pay.chooseTier')}
                    </option>
                  )}
                  {opts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="font-medium truncate">{sel?.name || t('plugins.title')}</div>
              )}
            </div>

            <div className="flex items-baseline justify-between mb-4">
              <span className="text-sm text-neutral-500">{t('pay.amount')}</span>
              <span className="flex items-baseline gap-2">
                {!!shownList && shownList > amount && (
                  <span className="text-sm text-neutral-400 line-through">¥{yuan(shownList)}</span>
                )}
                <span className="text-2xl font-bold text-brand-700">
                  {sel ? `¥${yuan(amount)}` : '—'}
                </span>
              </span>
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
                disabled={creating || !amount || !sel}
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
    </Modal>
  );
}
