'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AccountNav from '../../components/AccountNav';
import PluginCheckoutModal from '../../components/PluginCheckoutModal';
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
}

interface DeviceRow {
  device_id: string;
  device_name?: string | null;
  platform?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  pending?: boolean;
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
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payInfo, setPayInfo] = useState<{ id: string; name?: string; price: number } | null>(null);

  // 设备面板：按插件懒加载，展开时才请求
  const [deviceOpen, setDeviceOpen] = useState<string | null>(null);
  const [deviceData, setDeviceData] = useState<
    Record<string, { devices: DeviceRow[]; max_devices: number }>
  >({});
  const [deviceLoading, setDeviceLoading] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);

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
      // 失败时保留旧数据，绝不用空数组覆盖（否则一次抖动会把列表清空）
      if (mineRes.ok) {
        setSubs(await mineRes.json());
        setError(null);
      } else {
        setError(t('plugins.loadFailed'));
      }
      if (listRes.ok) {
        const list: Plugin[] = await listRes.json();
        const map: Record<string, Plugin> = {};
        for (const p of list) map[p.id] = p;
        setPlugins(map);
      }
    } catch {
      setError(t('plugins.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDevices = async (pluginId: string) => {
    setDeviceLoading(pluginId);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/devices`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setDeviceData((prev) => ({ ...prev, [pluginId]: data }));
      }
    } catch {
      /* 静默：面板会显示已有数据或空态 */
    } finally {
      setDeviceLoading(null);
    }
  };

  const toggleDevices = async (pluginId: string) => {
    const next = deviceOpen === pluginId ? null : pluginId;
    setDeviceOpen(next);
    if (next) await loadDevices(pluginId);
  };

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

  const revokeDevice = async (pluginId: string, deviceId: string) => {
    if (!confirm(t('plugins.revokeConfirm'))) return;
    setDeviceBusy(`${pluginId}:${deviceId}`);
    try {
      const res = await fetch(
        `/api/plugins/${pluginId}/devices/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: authHeaders() },
      );
      if (res.ok) await loadDevices(pluginId);
    } catch {
      /* 静默 */
    } finally {
      setDeviceBusy(null);
    }
  };

  const revokeAll = async (pluginId: string) => {
    if (!confirm(t('plugins.resetDevicesConfirm'))) return;
    setDeviceBusy(`${pluginId}:all`);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/reset-devices`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (res.ok) await loadDevices(pluginId);
    } catch {
      /* 静默 */
    } finally {
      setDeviceBusy(null);
    }
  };

  const statusLabel = (s: MySub) => {
    if (s.status === 'active' && new Date(s.expires_at).getTime() > Date.now())
      return t('plugins.active');
    if (s.status === 'cancelled') return t('plugins.cancelled');
    return t('plugins.expired');
  };
  const statusColor = (s: MySub) => {
    if (s.status === 'active' && new Date(s.expires_at).getTime() > Date.now())
      return 'bg-green-50 text-green-700 border-green-200';
    if (s.status === 'cancelled')
      return 'bg-neutral-100 text-neutral-500 border-neutral-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
  };

  const fmtDate = (v?: string | null) =>
    v ? new Date(v).toLocaleDateString('zh-CN') : '—';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <AccountNav />
      <h1 className="text-2xl font-bold mb-1">{t('plugins.myTitle')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('plugins.myHint')}</p>

      {error && (
        <div className="mb-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={load} className="shrink-0 underline">
            {t('plugins.retry')}
          </button>
        </div>
      )}

      {!getUserId() ? (
        <div className="text-sm text-neutral-400">
          {t('plugins.needLogin')}
          <Link href="/auth" className="text-brand-600 hover:underline">
            {t('nav.login')}
          </Link>
        </div>
      ) : loading ? (
        <div className="py-10 text-center text-sm text-neutral-400">{t('plugins.loading')}</div>
      ) : subs.length === 0 ? (
        <div className="py-10 text-center text-sm text-neutral-400">
          {t('home.noData')} ·{' '}
          <Link href="/plugins" className="text-brand-600 hover:underline">
            {t('plugins.goMarket')}
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {subs.map((s) => {
            const p = plugins[s.plugin_id];
            const valid = s.status === 'active' && new Date(s.expires_at).getTime() > Date.now();
            const dd = deviceData[s.plugin_id];
            const open = deviceOpen === s.plugin_id;
            return (
              <div key={s.id} className="bg-white border border-neutral-200 rounded-xl p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-neutral-900 truncate">
                      {p?.name || s.plugin_id}
                    </div>
                    <div className="text-xs text-neutral-400 mt-0.5">
                      {valid
                        ? `${t('plugins.validUntil')} ${fmtDate(s.expires_at)}`
                        : `${t('plugins.active')} ${fmtDate(s.started_at)}`}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-lg border ${statusColor(s)}`}
                  >
                    {statusLabel(s)}
                  </span>
                </div>

                {valid && (
                  <div className="mt-3 rounded-lg bg-neutral-50 border border-neutral-100 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs text-neutral-600">
                          {t('plugins.devicesUsed', {
                            n: dd?.devices?.length ?? 0,
                            max: dd?.max_devices ?? 2,
                          })}
                        </div>
                        {!open && (
                          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                            {t('plugins.activateHint')}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => toggleDevices(s.plugin_id)}
                        className="shrink-0 text-xs text-brand-600 border border-brand-200 rounded-md px-2.5 py-1 hover:bg-brand-50"
                      >
                        {open ? t('plugins.hideDevices') : t('plugins.manageDevices')}
                      </button>
                    </div>

                    {open && (
                      <div className="mt-3 border-t border-neutral-200 pt-3">
                        {deviceLoading === s.plugin_id && !dd ? (
                          <div className="py-3 text-center text-[11px] text-neutral-400">
                            {t('plugins.loading')}
                          </div>
                        ) : !dd?.devices?.length ? (
                          <div className="py-3 text-center text-[11px] text-neutral-400">
                            {t('plugins.noDevices')}
                          </div>
                        ) : (
                          <ul className="space-y-2">
                            {dd.devices.map((d) => (
                              <li
                                key={d.device_id}
                                className="flex items-center justify-between gap-3"
                              >
                                <div className="min-w-0">
                                  <div className="text-xs text-neutral-800 truncate">
                                    {d.device_name || t('plugins.unknownDevice')}
                                    {d.platform ? (
                                      <span className="text-neutral-400"> · {d.platform}</span>
                                    ) : null}
                                    {d.pending ? (
                                      <span className="ml-1.5 text-[10px] text-amber-600 border border-amber-200 rounded px-1">
                                        {t('plugins.devicePending')}
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="text-[11px] text-neutral-400">
                                    {t('plugins.lastSeen')} {fmtDate(d.last_seen_at)}
                                  </div>
                                </div>
                                <button
                                  onClick={() => revokeDevice(s.plugin_id, d.device_id)}
                                  disabled={deviceBusy === `${s.plugin_id}:${d.device_id}`}
                                  className="shrink-0 text-[11px] text-red-600 border border-red-200 rounded-md px-2 py-1 hover:bg-red-50 disabled:opacity-50"
                                >
                                  {deviceBusy === `${s.plugin_id}:${d.device_id}`
                                    ? t('plugins.revoking')
                                    : t('plugins.revoke')}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}

                        {!!dd?.devices?.length && (
                          <div className="mt-3 flex justify-end">
                            <button
                              onClick={() => revokeAll(s.plugin_id)}
                              disabled={deviceBusy === `${s.plugin_id}:all`}
                              className="text-[11px] text-neutral-500 border border-neutral-200 rounded-md px-2 py-1 hover:bg-neutral-100 disabled:opacity-50"
                            >
                              {deviceBusy === `${s.plugin_id}:all`
                                ? t('plugins.revoking')
                                : t('plugins.resetDevices')}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    onClick={() =>
                      setPayInfo({
                        id: s.plugin_id,
                        name: p?.name,
                        price: p?.price_monthly_cents || 0,
                      })
                    }
                    className="text-xs text-white bg-brand-600 rounded-lg px-3 py-1.5 hover:bg-brand-700"
                  >
                    {valid ? t('plugins.renew') : t('plugins.resubscribe')}
                  </button>
                  {valid && (
                    <button
                      onClick={() => handleCancel(s.plugin_id)}
                      disabled={busyId === s.plugin_id}
                      className="text-xs text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50 disabled:opacity-50"
                    >
                      {t('plugins.cancel')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {payInfo && (
        <PluginCheckoutModal
          pluginId={payInfo.id}
          pluginName={payInfo.name}
          priceCents={payInfo.price}
          onClose={() => setPayInfo(null)}
          onPaid={() => {
            setPayInfo(null);
            load();
          }}
        />
      )}
    </div>
  );
}
