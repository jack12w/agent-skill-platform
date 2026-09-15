'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';
import PluginCheckoutModal from '../components/PluginCheckoutModal';

interface Plugin {
  id: string;
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  icon_url?: string | null;
  category: string;
  price_monthly_cents: number;
  status: string;
  download_key?: string | null;
}

interface MySub {
  id: string;
  user_id: string;
  plugin_id: string;
  status: string;
  expires_at: string;
}

const EMOJI: Record<string, string> = {
  '客户开发': '🎯',
  '数据采集': '🛒',
  '自动化': '⚙️',
};

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function isAuthed(): boolean {
  try {
    return !!localStorage.getItem('token');
  } catch {
    return false;
  }
}

export default function PluginsPage() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [subs, setSubs] = useState<Record<string, MySub>>({});
  const [loading, setLoading] = useState(true);
  const [cat, setCat] = useState<string>('all');
  const [payId, setPayId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/plugins');
      if (res.ok) setPlugins(await res.json());
    } catch {
      /* 静默 */
    } finally {
      setLoading(false);
    }
  };

  const loadMine = async () => {
    if (!isAuthed()) return;
    try {
      const res = await fetch('/api/plugins/mine', { headers: authHeaders() });
      if (res.ok) {
        const list: MySub[] = await res.json();
        const map: Record<string, MySub> = {};
        for (const s of list) map[s.plugin_id] = s;
        setSubs(map);
      }
    } catch {
      /* 静默 */
    }
  };

  useEffect(() => {
    load();
    loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categories = useMemo(() => {
    const set = new Set(plugins.map((p) => p.category));
    return ['all', ...Array.from(set)];
  }, [plugins]);

  const visible = useMemo(
    () => (cat === 'all' ? plugins : plugins.filter((p) => p.category === cat)),
    [plugins, cat],
  );

  const isActive = (p: Plugin): MySub | null => {
    const s = subs[p.id];
    if (!s) return null;
    return s.status === 'active' && new Date(s.expires_at).getTime() > Date.now() ? s : null;
  };

  const handleDownload = async (p: Plugin) => {
    if (!isAuthed()) {
      window.location.href = '/auth';
      return;
    }
    try {
      const res = await fetch(`/api/plugins/${p.id}/download`, { headers: authHeaders() });
      if (res.status === 401) {
        window.location.href = '/auth';
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || '下载失败');
      }
      const data = await res.json();
      if (data?.url) window.location.href = data.url;
      else setErr('未获取到下载地址');
    } catch (e: any) {
      setErr(e.message || '下载失败');
    }
  };

  const onPaid = () => {
    setPayId(null);
    loadMine();
  };

  const yuan = (cents: number) => (Number(cents) / 100).toFixed(0);

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Hero */}
      <div className="bg-gradient-to-b from-brand-50 to-neutral-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 text-center">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-neutral-900">
            {t('plugins.title')}
          </h1>
          <p className="mt-3 text-sm sm:text-base text-neutral-500 max-w-2xl mx-auto">
            {t('plugins.subtitle')}
          </p>
          <div className="mt-5 inline-block rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-brand-700 border border-brand-100">
            🚀 {plugins.length} 款能力已上线，更多正在路上
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-20">
        {/* 分类条 */}
        <div className="flex flex-wrap gap-2 my-8">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full px-4 py-1.5 text-sm border transition ${
                cat === c
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-100'
              }`}
            >
              {c === 'all' ? t('plugins.allFilter') : c}
            </button>
          ))}
        </div>

        {err && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</div>
        )}

        {loading ? (
          <div className="py-20 text-center text-sm text-neutral-400">加载中…</div>
        ) : visible.length === 0 ? (
          <div className="py-20 text-center text-sm text-neutral-400">{t('home.noData')}</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {visible.map((p) => {
              const sub = isActive(p);
              const emoji = p.icon_url ? null : EMOJI[p.category] || '🧩';
              const features = (p.description || '')
                .split(/[；;]/)
                .map((s) => s.trim())
                .filter(Boolean);
              return (
                <div
                  key={p.id}
                  className={`flex flex-col bg-white rounded-2xl border p-6 transition hover:shadow-lg ${
                    sub ? 'border-green-200' : 'border-neutral-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-brand-50 flex items-center justify-center text-2xl">
                      {p.icon_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.icon_url} alt={p.name} className="w-12 h-12 rounded-xl object-cover" />
                      ) : (
                        <span>{emoji}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-neutral-900 truncate">{p.name}</div>
                      <div className="text-xs text-neutral-400">{p.category}</div>
                    </div>
                  </div>

                  {sub ? (
                    <div className="mt-4 inline-flex items-center gap-1.5 self-start rounded-lg bg-green-50 border border-green-200 px-2.5 py-1 text-xs font-semibold text-green-700">
                      ✓ {t('plugins.subscribed')} · {t('plugins.validUntil')}{' '}
                      {new Date(sub.expires_at).toLocaleDateString('zh-CN')}
                    </div>
                  ) : (
                    p.tagline && <p className="mt-4 text-sm text-neutral-500">{p.tagline}</p>
                  )}

                  <div className="mt-3 flex-1">
                    {features.length > 0 ? (
                      <ul className="space-y-1.5 text-sm text-neutral-600">
                        {features.map((f, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-brand-600 font-bold">✓</span>
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-neutral-600">{p.description}</p>
                    )}
                  </div>

                  <div className="mt-5 flex items-end justify-between">
                    <div>
                      <span className="text-2xl font-extrabold text-neutral-900">¥{yuan(p.price_monthly_cents)}</span>
                      <span className="text-sm text-neutral-400 ml-1">{t('plugins.perMonth')}</span>
                    </div>
                  </div>

                  <div className="mt-4 flex gap-3">
                    <button
                      onClick={() => handleDownload(p)}
                      className="flex-1 rounded-lg border border-neutral-200 py-2.5 text-sm font-semibold text-neutral-700 bg-white hover:border-brand-400 hover:text-brand-600"
                    >
                      {t('plugins.download')}
                    </button>
                    {sub ? (
                      <Link
                        href="/account/plugins"
                        className="flex-1 rounded-lg border border-neutral-200 py-2.5 text-sm font-semibold text-neutral-700 bg-white text-center hover:bg-neutral-50"
                      >
                        {t('plugins.manage')}
                      </Link>
                    ) : (
                      <button
                        onClick={() => {
                          if (!isAuthed()) {
                            window.location.href = '/auth';
                            return;
                          }
                          setPayId(p.id);
                        }}
                        className="flex-1 rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
                      >
                        {t('plugins.subscribe')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-10 text-center text-xs text-neutral-400">{t('plugins.freeDownloadTip')}</p>
      </div>

      {payId && (
        <PluginCheckoutModal
          pluginId={payId}
          pluginName={plugins.find((p) => p.id === payId)?.name}
          priceCents={plugins.find((p) => p.id === payId)?.price_monthly_cents || 0}
          onClose={() => setPayId(null)}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}
