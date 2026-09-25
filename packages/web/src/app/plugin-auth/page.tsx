'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

interface PendingResp {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  deny_reason?: string;
  plugin?: { slug: string; name: string; tagline?: string | null };
  device_name?: string | null;
  platform?: string | null;
  subscribed: boolean;
  subscription_expires_at?: string;
  devices_used: number;
  max_devices: number;
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

  const loadPending = useCallback(async () => {
    if (!code) {
      setError(t('plugins.authNoCode'));
      return;
    }
    try {
      const res = await fetch(
        `/api/plugins/auth/pending?code=${encodeURIComponent(code)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) {
        setError(t('plugins.authNotFound'));
        return;
      }
      setError(null);
      setInfo(await res.json());
    } catch {
      setError(t('plugins.loadFailed'));
    }
  }, [code, t]);

  useEffect(() => {
    if (ready && loggedIn && code) loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loggedIn, code]);

  const decide = async (action: 'approve' | 'deny') => {
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/auth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ code, action }),
      });
      const data: ApproveResp = await res.json().catch(() => ({ ok: false }));
      if (!res.ok) {
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

      {!error && !expired && !already && info && (
        <div className="bg-white border border-neutral-200 rounded-xl p-5">
          <div className="text-center mb-4">
            <div className="font-semibold text-neutral-900">
              {t('plugins.authRequest', { name: info.plugin?.name || '—' })}
            </div>
            {info.plugin?.tagline && (
              <div className="text-xs text-neutral-400 mt-1">{info.plugin.tagline}</div>
            )}
          </div>

          <dl className="text-xs space-y-2 border-t border-neutral-100 pt-4">
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-400">{t('plugins.authDevice')}</dt>
              <dd className="text-neutral-700 text-right min-w-0 truncate">
                {info.device_name || t('plugins.unknownDevice')}
                {info.platform ? ` · ${info.platform}` : ''}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-400">{t('plugins.authDevicesUsed')}</dt>
              <dd className="text-neutral-700">
                {t('plugins.devicesUsed', {
                  n: info.devices_used,
                  max: info.max_devices,
                })}
              </dd>
            </div>
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
              <p className="text-xs text-neutral-500 text-center">
                {t('plugins.authSubscribeFirst')}
              </p>
              <Link
                href="/plugins"
                className="block text-center text-sm text-white bg-brand-600 rounded-lg px-4 py-2.5 hover:bg-brand-700"
              >
                {t('plugins.goMarket')}
              </Link>
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
                disabled={busy}
                className="flex-1 text-sm text-white bg-brand-600 rounded-lg px-4 py-2.5 hover:bg-brand-700 disabled:opacity-50"
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
    </div>
  );
}
