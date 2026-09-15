'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AccountNav from '../../components/AccountNav';
import useTranslation from '../../../hooks/useTranslation';

interface Plugin {
  id: string;
  name: string;
  category: string;
  price_monthly_cents: number;
}
interface MySub {
  id: string;
  plugin_id: string;
  status: string;
  expires_at: string;
  started_at: string;
  license_key?: string | null;
}

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
function getUserId(): string | null {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')?.id || null;
  } catch {
    return null;
  }
}

export default function MyPluginsPage() {
  const { t } = useTranslation();
  const [subs, setSubs] = useState<MySub[]>([]);
  const [plugins, setPlugins] = useState<Record<string, Plugin>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = async () => {
    if (!getUserId()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [mineRes, listRes] = await Promise.all([
        fetch('/api/plugins/mine', { headers: authHeaders() }),
        fetch('/api/plugins'),
      ]);
      if (mineRes.ok) setSubs(await mineRes.json());
      if (listRes.ok) {
        const list: Plugin[] = await listRes.json();
        const map: Record<string, Plugin> = {};
        for (const p of list) map[p.id] = p;
        setPlugins(map);
      }
    } catch {
      /* 静默 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = async (pluginId: string) => {
    if (!confirm(t('plugins.cancelConfirm'))) return;
    setBusyId(pluginId);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/cancel`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (res.ok) load();
    } catch {
      /* 静默 */
    } finally {
      setBusyId(null);
    }
  };

  const copyKey = async (sub: MySub) => {
    if (!sub.license_key) return;
    try {
      await navigator.clipboard.writeText(sub.license_key);
      setCopiedId(sub.id);
      setTimeout(() => setCopiedId((v) => (v === sub.id ? null : v)), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const statusLabel = (s: MySub) => {
    if (s.status === 'active' && new Date(s.expires_at).getTime() > Date.now()) return t('plugins.active');
    if (s.status === 'cancelled') return t('plugins.cancelled');
    return t('plugins.expired');
  };
  const statusColor = (s: MySub) => {
    if (s.status === 'active' && new Date(s.expires_at).getTime() > Date.now())
      return 'bg-green-50 text-green-700 border-green-200';
    if (s.status === 'cancelled') return 'bg-neutral-100 text-neutral-500 border-neutral-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <AccountNav />
      <h1 className="text-2xl font-bold mb-1">{t('plugins.myTitle')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('plugins.myHint')}</p>

      {!getUserId() ? (
        <div className="text-sm text-neutral-400">
          请先<Link href="/auth" className="text-brand-600 hover:underline">登录</Link>
        </div>
      ) : loading ? (
        <div className="py-10 text-center text-sm text-neutral-400">加载中…</div>
      ) : subs.length === 0 ? (
        <div className="py-10 text-center text-sm text-neutral-400">
          {t('home.noData')} · <Link href="/plugins" className="text-brand-600 hover:underline">去插件市场</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {subs.map((s) => {
            const p = plugins[s.plugin_id];
            const valid = s.status === 'active' && new Date(s.expires_at).getTime() > Date.now();
            return (
              <div key={s.id} className="bg-white border border-neutral-200 rounded-xl p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-neutral-900 truncate">{p?.name || s.plugin_id}</div>
                    <div className="text-xs text-neutral-400 mt-0.5">
                      {valid
                        ? `${t('plugins.validUntil')} ${new Date(s.expires_at).toLocaleDateString('zh-CN')}`
                        : `${t('plugins.active')} ${new Date(s.started_at).toLocaleDateString('zh-CN')}`}
                    </div>
                  </div>
                  <span className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-lg border ${statusColor(s)}`}>
                    {statusLabel(s)}
                  </span>
                </div>

                {/* 卡密（仅生效中显示） */}
                {valid && s.license_key && (
                  <div className="mt-3 rounded-lg bg-neutral-50 border border-neutral-100 p-3">
                    <div className="text-xs text-neutral-500 mb-1.5">{t('plugins.licenseKey')}</div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 min-w-0 truncate font-mono text-sm text-neutral-800 select-all">
                        {revealId === s.id ? s.license_key : '•••• •••• •••• ••••'}
                      </code>
                      <button
                        onClick={() => setRevealId((v) => (v === s.id ? null : s.id))}
                        className="shrink-0 text-xs text-neutral-500 hover:text-brand-600 underline"
                      >
                        {revealId === s.id ? t('plugins.keyHidden') : t('plugins.keyVisible')}
                      </button>
                      <button
                        onClick={() => copyKey(s)}
                        className="shrink-0 text-xs text-white bg-brand-600 rounded-md px-2.5 py-1 hover:bg-brand-700"
                      >
                        {copiedId === s.id ? t('plugins.copied') : t('plugins.copyKey')}
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{t('plugins.activateHint')}</p>
                  </div>
                )}

                {valid && (
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={() => handleCancel(s.plugin_id)}
                      disabled={busyId === s.plugin_id}
                      className="text-xs text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50 disabled:opacity-50"
                    >
                      {t('plugins.cancel')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
