'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';
import PluginCheckoutModal from '../components/PluginCheckoutModal';

/** 可授权的订阅档位（0046，一档一台） */
interface TierOption {
  subscription_id: string;
  plan_slug: string | null;
  plan_name: string | null;
  /** personal = 个人档；team = 团队档（> 1 席，含 AI） */
  via: 'personal' | 'team';
  entitled: boolean;
  expires_at: string | null;
  /** 团队档才有：可授权账号数（含团长） */
  seats: number | null;
  /** 本档设备额度 / 本人已占用 */
  quota: number;
  used: number;
  remaining: number;
  full: boolean;
  recommended: boolean;
}

/** 订阅失效时可就地购买的档位（后端 purchasableTiers 返回，价格与下单同源） */
interface PurchaseOption {
  id: string;
  name: string;
  priceCents: number;
  listCents: number;
  durationDays: number;
}

interface PendingResp {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  deny_reason?: string;
  /** 授权码：与插件端显示的同一个码，用于人工比对（本身不是凭据） */
  code?: string;
  /** 请求发起时间（ISO）：用户据此判断「是不是我刚才点的那一下」 */
  created_at?: string;
  plugin?: { slug: string; name: string; tagline?: string | null };
  device_name?: string | null;
  platform?: string | null;
  subscribed: boolean;
  subscription_expires_at?: string;
  devices_used: number;
  max_devices: number;
  /** 可选的订阅档位（新增）；空数组/缺省 = 老后端，退化为不显示下拉 */
  options?: TierOption[];
  /** 仅「待授权 + 未订阅」时返回：就地付费的可选档位 */
  purchase_options?: PurchaseOption[];
  /** 由历史订阅 plan_slug 精确解析出的默认档位；null = 解析不到，强制手动选 */
  purchase_default_id?: string | null;
  /** 档位查询异常：不等于免费、不等于失效，展示「不可用 + 重试」 */
  purchase_unavailable?: boolean;
}

/** 8 位授权码按 4+4 展示，便于与插件端逐位比对 */
function fmtCode(code: string): string {
  const c = String(code || '');
  return c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c;
}

/** 本地时间展示（与页面上订阅到期时间的展示口径一致） */
function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN');
}

/**
 * 档位下拉项文案。三种状态必须一眼可辨：
 *   · 可用   → 「Pro 标准版 · 可用 1/1 台」
 *   · 已满   → 「基础版 · 名额已满」（置灰，提示用户升档）
 *   · 已过期 → 「新用户试用 · 已过期」（置灰，但不隐藏 —— 用户会以为「我没买过」）
 * 团队档额外标注「团队 N 人」：让团长明白 3 席是 3 个人，不是本机 3 台设备。
 */
function tierLabel(
  o: TierOption,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const base = o.plan_name || o.plan_slug || '—';
  if (!o.entitled) return `${base} · ${t('plugins.authTierExpired')}`;
  if (o.full) return `${base} · ${t('plugins.authTierFull')}`;
  const dev = t('plugins.authTierRemaining', { used: o.used, quota: o.quota });
  const seats = Number(o.seats ?? 0);
  const isTeam = seats > 1;
  const team = isTeam ? ` · ${t('plugins.authTierTeam', { n: seats })}` : '';
  /* 档位能力写进选项（2026-10-29 设备级鉴权）：AI 只跟着**这台设备选中的这一档**走。
     之前只标席位，用户看不出「选基础版 = 这台机器没有 AI」，选完才发现少功能。 */
  const ai = isTeam ? t('plugins.planHasAi') : t('plugins.planNoAiShort');
  return `${base} · ${dev}${team} · ${ai}`;
}

interface ApproveResp {
  ok: boolean;
  status?: string;
  reason?: string;
  message?: string;
  already?: boolean;
  expires_at?: string;
  devices_used?: number;
  max_devices?: number;
}

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
function hasLogin(): boolean {
  try {
    return !!localStorage.getItem('token');
  } catch {
    return false;
  }
}

/**
 * 插件设备授权页。
 *
 * 流程：插件（或用户手动）打开 /plugin-auth?code=XXXXXXXX → 用户在此确认授权 →
 * 插件轮询到 approved 并取走一次性设备令牌。
 *
 * 安全要点：本页**只发出「确认」意图**，真正的 device_id 由后端从授权请求记录里读，
 * 不信任本页传参 —— 保证用户确认的就是他刚刚在插件里发起的那台设备。
 */
export default function PluginAuthPage() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [info, setInfo] = useState<PendingResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApproveResp | null>(null);
  /** 用户选中的订阅档位（0046，一档一台）。默认由后端 recommended 指定 */
  const [selectedSub, setSelectedSub] = useState<string>('');
  /** 就地付费弹窗 */
  const [payOpen, setPayOpen] = useState(false);
  /** 付款成功后的权益同步：成功 / 失败 / 进行中三态分开 */
  const [syncing, setSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      setCode((params.get('code') || '').trim());
    } catch {
      /* 忽略 */
    }
    setLoggedIn(hasLogin());
    setReady(true);
  }, []);

  const loadPending = useCallback(async (): Promise<PendingResp | null> => {
    if (!code) {
      setError(t('plugins.authNoCode'));
      return null;
    }
    try {
      /* ⚠️ `cache: 'no-store'` 必须加。本页顶部的「已授权 N/M 台设备」要反映用户
       * 刚刚在「我的订阅」里做的解绑，也反映刚刚付款后新写入的订阅 ——
       * 响应没有 Cache-Control 时浏览器会按启发式规则复用旧快照，
       * 于是「解绑/续费成功 → 打开授权页仍显示旧值」。 */
      const res = await fetch(
        `/api/plugins/auth/pending?code=${encodeURIComponent(code)}`,
        { headers: authHeaders(), cache: 'no-store' },
      );
      if (!res.ok) {
        setError(t('plugins.authNotFound'));
        return null;
      }
      setError(null);
      const data: PendingResp = await res.json();
      setInfo(data);
      /**
       * 默认档位：后端 marked 的 recommended（在期内且未满、到期最晚）。
       * 用户什么都不点也能直接确认 —— 下拉只是「想换一档」时的入口，不是必填步骤。
       */
      const opts = Array.isArray(data?.options) ? data.options : [];
      const def = opts.find((o) => o.recommended) ?? opts[0];
      setSelectedSub(def ? def.subscription_id : '');
      return data;
    } catch {
      setError(t('plugins.loadFailed'));
      return null;
    }
  }, [code, t]);

  useEffect(() => {
    if (ready && loggedIn && code) void loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loggedIn, code]);

  /**
   * 支付成功 ≠ 发货完成：轮询到 PAID 时支付回调可能还没写完订阅行。
   * 带重试重拉 pending，直到 subscribed=true，按钮自动变成「确认授权」，全程不跳页。
   * 6 次仍拿不到 → 归「不确定」：显示「付款已成功、状态待确认」+ 手动重试，
   * 绝不退回「未订阅」引导用户重复付款（三态铁律）。
   */
  const syncAfterPaid = async () => {
    setPayOpen(false);
    setSyncing(true);
    setSyncFailed(false);
    for (let i = 0; i < 6; i++) {
      const data = await loadPending();
      if (data?.subscribed) {
        setSyncing(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    setSyncing(false);
    setSyncFailed(true);
  };

  const decide = async (action: 'approve' | 'deny') => {
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/auth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          code,
          action,
          // 一档一台：确认时告诉后端占哪一档的名额（不传则后端自动选）
          ...(action === 'approve' && selectedSub
            ? { subscription_id: selectedSub }
            : {}),
        }),
      });
      const data: ApproveResp = await res.json().catch(() => ({ ok: false }));
      if (!res.ok) {
        // 名额已满 / 档位失效会走这里（后端抛 400，不改请求状态）——
        // 停在原页面，用户可以改选另一档或去解绑，不必回插件重新发起。
        setError(data?.message || t('plugins.authFailed'));
        return;
      }
      setResult(data);
      if (data.ok) await loadPending();
    } catch {
      setError(t('plugins.authFailed'));
    } finally {
      setBusy(false);
    }
  };

  const loginHref = `/auth?redirect=${encodeURIComponent(`/plugin-auth?code=${code}`)}`;

  // ── 未登录 ──
  if (ready && !loggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <h1 className="text-xl font-bold mb-2">{t('plugins.authTitle')}</h1>
        <p className="text-sm text-neutral-500 mb-6">{t('plugins.authLoginFirst')}</p>
        <Link
          href={loginHref}
          className="inline-block text-sm text-white bg-brand-600 rounded-lg px-5 py-2.5 hover:bg-brand-700"
        >
          {t('nav.login')}
        </Link>
      </div>
    );
  }

  // ── 已处理完成 ──
  if (result?.ok) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="text-3xl mb-3">✓</div>
        <h1 className="text-xl font-bold mb-2">{t('plugins.authDone')}</h1>
        <p className="text-sm text-neutral-500">{t('plugins.authDoneHint')}</p>
      </div>
    );
  }
  if (result && !result.ok) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <h1 className="text-xl font-bold mb-2">{t('plugins.authDeniedTitle')}</h1>
        <p className="text-sm text-neutral-500">{result.message || t('plugins.authDenied')}</p>
      </div>
    );
  }

  const expired = info?.status === 'expired';
  const already = info?.status === 'approved';
  const denied = info?.status === 'denied';

  /**
   * 档位下拉（0046）：
   *   · options 为空（老后端 / 无订阅）→ 不渲染这一行
   *   · 只有 1 档 → 不渲染下拉，只显示文案（单档用户零感知，界面与改动前一致）
   *   · ≥2 档 → 渲染下拉，满了/过期的项置灰（不隐藏：用户要知道自己买过 Pro）
   * 订阅失效时不给下拉：此时没有可用档位，选了也没用，且会和收银台的档位下拉打架。
   */
  const tierOptions = info?.options ?? [];
  const currentTier =
    tierOptions.find((o) => o.subscription_id === selectedSub) ?? tierOptions[0];
  const tierBlocked = !!currentTier && (!currentTier.entitled || currentTier.full);

  /** 失效态细分：options 里有「已过期」行 = 买过、现在失效 → 「续费」；否则「订阅」 */
  const hadSubscription = tierOptions.some((o) => !o.entitled);
  const purchase = info?.purchase_options ?? [];
  const purchaseUnavailable = !!info?.purchase_unavailable || purchase.length === 0;
  const defaultPurchaseId = info?.purchase_default_id || null;
  const chosenDefault = defaultPurchaseId
    ? purchase.find((o) => o.id === defaultPurchaseId) ?? null
    : null;
  const modalBase = chosenDefault ?? purchase[0] ?? null;

  return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <h1 className="text-xl font-bold mb-1 text-center">{t('plugins.authTitle')}</h1>
      <p className="text-sm text-neutral-500 text-center mb-6">{t('plugins.authSubtitle')}</p>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-center">
          {error}
        </div>
      )}

      {!error && expired && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-center">
          {t('plugins.authExpired')}
        </div>
      )}

      {!error && already && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-center">
          {t('plugins.authAlready')}
        </div>
      )}

      {/* 已拒绝是终态：不能再回退成「批准」，只能从插件重新发起 */}
      {!error && denied && (
        <div className="text-sm text-neutral-700 bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-3 text-center">
          {t('plugins.authDenied')}
          {t('plugins.authDeniedRestart')}
        </div>
      )}

      {!error && !expired && !already && !denied && info && (
        <div className="bg-white border border-neutral-200 rounded-xl p-5">
          <div className="text-center mb-4">
            <div className="font-semibold text-neutral-900">
              {t('plugins.authRequest', { name: info.plugin?.name || '—' })}
            </div>
            {info.plugin?.tagline && (
              <div className="text-xs text-neutral-400 mt-1">{info.plugin.tagline}</div>
            )}
          </div>

          {/*
            授权码 + 发起时间：设备码流程（RFC 8628）唯一的钓鱼拦截手段。
            攻击者可以在自己机器上发起授权、把链接发给别人诱导点击确认；用户能核对的
            只有「这个码跟我插件里显示的一样吗」和「这条请求是我刚才发起的吗」——
            没有这两样，页面对用户而言就是「莫名其妙让我点确认」。
          */}
          {info.code && (
            <div className="mb-4 rounded-lg bg-neutral-50 border border-neutral-200 px-4 py-3 text-center">
              <div className="text-[11px] text-neutral-400 mb-1">
                {t('plugins.authCodeLabel')}
              </div>
              <div className="font-mono text-2xl font-bold tracking-[0.2em] text-neutral-900">
                {fmtCode(info.code)}
              </div>
              <div className="text-[11px] leading-relaxed text-neutral-400 mt-2">
                {t('plugins.authCodeHint')}
              </div>
            </div>
          )}

          <dl className="text-xs space-y-2 border-t border-neutral-100 pt-4">
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-400">{t('plugins.authDevice')}</dt>
              <dd className="text-neutral-700 text-right min-w-0 truncate">
                {info.device_name || t('plugins.unknownDevice')}
                {info.platform ? ` · ${info.platform}` : ''}
              </dd>
            </div>
            {/* 设备名由发起方自填、接口未认证 —— 必须标注「仅供参考」，不能当事实展示 */}
            <div className="text-right text-[11px] text-neutral-400">
              {t('plugins.authDeviceHint')}
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-400">{t('plugins.authRequestedAt')}</dt>
              <dd className="text-neutral-700">{fmtTime(info.created_at)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-400">{t('plugins.authDevicesUsed')}</dt>
              <dd className="text-neutral-700">
                {/* ★ 一卡一台（2026-10-29）：显示**所选档位**自己的额度，
                    不是插件族总量。用户有基础版(1)+Team(1) 时，总量是 2 ——
                    贴在「基础版」上会被读成「基础版能绑 2 台」。
                    没有档位信息（老后端）时才退回总量兜底。 */}
                {currentTier
                  ? t('plugins.devicesUsed', {
                      n: currentTier.used,
                      max: currentTier.quota,
                    })
                  : t('plugins.devicesUsed', {
                      n: info.devices_used,
                      max: info.max_devices,
                    })}
              </dd>
            </div>
            {/* 授权使用哪一档（0046 一档一台）：失效时只显示文案，不给下拉 */}
            {currentTier && (
              <div className="flex justify-between items-center gap-3">
                <dt className="text-neutral-400 whitespace-nowrap">
                  {t('plugins.authTier')}
                </dt>
                <dd className="text-neutral-700 text-right min-w-0">
                  {info.subscribed && tierOptions.length > 1 ? (
                    <select
                      value={currentTier.subscription_id}
                      onChange={(e) => setSelectedSub(e.target.value)}
                      className="max-w-[15rem] text-xs border border-neutral-200 rounded-md px-2 py-1.5 bg-white text-neutral-700 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      {tierOptions.map((o) => (
                        <option
                          key={o.subscription_id}
                          value={o.subscription_id}
                          disabled={!o.entitled || o.full}
                        >
                          {tierLabel(o, t)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="truncate">{tierLabel(currentTier, t)}</span>
                  )}
                </dd>
              </div>
            )}
            {tierBlocked && info.subscribed && (
              <div className="text-[11px] leading-relaxed text-amber-600 text-right">
                {t('plugins.authTierBlocked')}
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-400">{t('plugins.authSubStatus')}</dt>
              <dd className={info.subscribed ? 'text-green-700' : 'text-red-600'}>
                {info.subscribed
                  ? `${t('plugins.validUntil')} ${
                      info.subscription_expires_at
                        ? new Date(info.subscription_expires_at).toLocaleDateString('zh-CN')
                        : '—'
                    }`
                  : t('plugins.authNoSubscription')}
              </dd>
            </div>
          </dl>

          {!info.subscribed ? (
            <div className="mt-5 space-y-3">
              {syncing || syncFailed ? (
                /* 付款已完成、权益同步结果未知 = 「不确定」态。隐藏支付按钮，
                   给重试而不是重新引导付费，避免重复下单。 */
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-center">
                  <p>{syncing ? t('plugins.authSyncing') : t('plugins.authSyncFailed')}</p>
                  {!syncing && (
                    <button
                      onClick={() => void syncAfterPaid()}
                      className="mt-2 text-brand-600 underline"
                    >
                      {t('plugins.authSyncRetry')}
                    </button>
                  )}
                </div>
              ) : purchaseUnavailable ? (
                /* 档位查询失败 / 没上架商品 ≠ 免费、≠ 订阅失效：给重试和市场页兜底入口 */
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-center">
                  <p>{t('plugins.authTiersUnavailable')}</p>
                  <button
                    onClick={() => void loadPending()}
                    className="mt-2 text-brand-600 underline"
                  >
                    {t('plugins.authSyncRetry')}
                  </button>
                  <Link href="/plugins" className="block mt-2 text-neutral-500 underline">
                    {t('plugins.goMarket')}
                  </Link>
                </div>
              ) : (
                <>
                  <p className="text-xs text-neutral-500 text-center">
                    {hadSubscription
                      ? t('plugins.authExpiredSubscribeHint')
                      : t('plugins.authSubscribeFirst')}
                  </p>
                  <button
                    onClick={() => setPayOpen(true)}
                    className="block w-full text-center text-sm text-white bg-brand-600 rounded-lg px-4 py-2.5 hover:bg-brand-700"
                  >
                    {hadSubscription
                      ? t('plugins.authRenewNow')
                      : t('plugins.authSubscribeNow')}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => decide('deny')}
                disabled={busy}
                className="flex-1 text-sm text-neutral-600 border border-neutral-200 rounded-lg px-4 py-2.5 hover:bg-neutral-50 disabled:opacity-50"
              >
                {t('plugins.authDeny')}
              </button>
              <button
                onClick={() => decide('approve')}
                disabled={busy || tierBlocked}
                title={tierBlocked ? t('plugins.authTierBlocked') : undefined}
                className="flex-1 text-sm text-white bg-brand-600 rounded-lg px-4 py-2.5 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? t('plugins.authProcessing') : t('plugins.authConfirm')}
              </button>
            </div>
          )}

          <p className="mt-4 text-[11px] leading-relaxed text-neutral-400 text-center">
            {t('plugins.authTip')}
          </p>
        </div>
      )}

      {/* 就地收银台：复用市场页同一个弹窗，付款成功后重拉 pending 自动回到确认授权 */}
      {payOpen && !info?.subscribed && modalBase && (
        <PluginCheckoutModal
          pluginId={modalBase.id}
          pluginName={modalBase.name}
          priceCents={modalBase.priceCents}
          listCents={modalBase.listCents}
          options={purchase.map((o) => ({
            id: o.id,
            name: o.name,
            priceCents: o.priceCents,
            listCents: o.listCents,
          }))}
          defaultOptionId={chosenDefault?.id || undefined}
          requireChoice={!chosenDefault && purchase.length > 1}
          onClose={() => setPayOpen(false)}
          onPaid={() => void syncAfterPaid()}
        />
      )}
    </div>
  );
}
