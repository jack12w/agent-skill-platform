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
  /** 用户是否手动改过名：true 时后端不会再被客户端上报值覆盖 */
  name_custom?: boolean;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [payInfo, setPayInfo] = useState<{ id: string; name?: string; price: number } | null>(null);

  // 设备面板：按插件懒加载，展开时才请求
  const [deviceOpen, setDeviceOpen] = useState<string | null>(null);
  const [deviceData, setDeviceData] = useState<
    Record<string, { devices: DeviceRow[]; max_devices: number }>
  >({});
  const [deviceLoading, setDeviceLoading] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  // 内联改名：一次只允许改一行（`${pluginId}:${deviceId}`），避免多点并发写同一张表
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

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
      // ⚠️ 失败必须说出来。旧实现失败时静默 —— 用户点了「取消订阅」什么也没发生，
      //    以为已经退订（下个月被扣费就是投诉）。
      if (res.ok) {
        const sub = subs.find((x) => x.plugin_id === pluginId);
        setNotice(t('plugins.cancelDone', { date: fmtDate(sub?.expires_at) }));
        load();
      } else {
        setNotice(t('plugins.cancelFailed'));
      }
    } catch {
      setNotice(t('plugins.cancelFailed'));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 设备改名。成功后**只更新这一行的本地状态**（不整块重拉）：
   * 重拉会把整个设备面板刷成 loading、还会覆盖用户正在编辑的其他行。
   * 失败必须说出来 —— 改名静默失败，用户会以为已经改好，下次登录看到旧名再改一次，
   * 而「改了没生效」这件事本身没有任何可观测的地方。
   */
  const renameDevice = async (pluginId: string, deviceId: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const key = `${pluginId}:${deviceId}`;
    setDeviceBusy(key);
    try {
      const res = await fetch(
        `/api/plugins/${pluginId}/devices/${encodeURIComponent(deviceId)}`,
        {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_name: clean }),
        },
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const saved = data?.device_name || clean;
        setDeviceData((prev) => {
          const cur = prev[pluginId];
          if (!cur) return prev;
          return {
            ...prev,
            [pluginId]: {
              ...cur,
              devices: cur.devices.map((d) =>
                d.device_id === deviceId
                  ? { ...d, device_name: saved, name_custom: true }
                  : d,
              ),
            },
          };
        });
        setRenameKey(null);
        setRenameValue('');
        setNotice(t('plugins.renameDone', { name: saved }));
      } else {
        setNotice(t('plugins.renameFailed'));
      }
    } catch {
      setNotice(t('plugins.renameFailed'));
    } finally {
      setDeviceBusy(null);
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

  /**
   * 权益判定。**必须与后端 `isSubscriptionEntitled`（plugin-auth.util.ts）逐条对齐**：
   * active / cancelled 且未到期 → 有权；expired → 无权（即使 expires_at 在未来，
   * 那是后台强制终止的语义，前端不能把它显示成「还能用」）。
   *
   * 2026-09-26 修正：旧判定写死 `status === 'active'`，于是「取消订阅」一按，
   * 页面上设备面板、剩余天数全部消失，看起来像被断供了 —— 而权益其实还在。
   */
  const isEntitled = (s: MySub) =>
    (s.status === 'active' || s.status === 'cancelled') &&
    new Date(s.expires_at).getTime() > Date.now();

  const statusLabel = (s: MySub) => {
    if (s.status === 'cancelled') return isEntitled(s) ? t('plugins.cancelledUntil') : t('plugins.expired');
    if (isEntitled(s)) return t('plugins.active');
    return t('plugins.expired');
  };
  const statusColor = (s: MySub) => {
    if (s.status === 'cancelled') {
      return isEntitled(s)
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-neutral-100 text-neutral-500 border-neutral-200';
    }
    if (isEntitled(s)) return 'bg-green-50 text-green-700 border-green-200';
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

      {notice && (
        <div className="mb-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="shrink-0 text-lg leading-none text-amber-500 hover:text-amber-700"
            aria-label="close"
          >
            ×
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
            const valid = isEntitled(s);
            const cancelled = s.status === 'cancelled';
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

                {/* 取消后权益仍在 → 必须明说，否则用户会以为自己被断供了（甚至来问退款） */}
                {cancelled && valid && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    {t('plugins.cancelledHint', { date: fmtDate(s.expires_at) })}
                  </p>
                )}

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
                            {dd.devices.map((d) => {
                              const rowKey = `${s.plugin_id}:${d.device_id}`;
                              const editing = renameKey === rowKey;
                              const rowBusy = deviceBusy === rowKey;
                              return (
                                <li
                                  key={d.device_id}
                                  className="flex items-center justify-between gap-3"
                                >
                                  <div className="min-w-0 flex-1">
                                    {editing ? (
                                      <input
                                        autoFocus
                                        value={renameValue}
                                        maxLength={40}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            renameDevice(s.plugin_id, d.device_id, renameValue);
                                          } else if (e.key === 'Escape') {
                                            setRenameKey(null);
                                            setRenameValue('');
                                          }
                                        }}
                                        placeholder={t('plugins.renamePlaceholder')}
                                        className="w-full text-xs text-neutral-800 border border-brand-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                                      />
                                    ) : (
                                      <>
                                        <div className="text-xs text-neutral-800 truncate">
                                          {d.device_name || t('plugins.unknownDevice')}
                                          {d.platform ? (
                                            <span className="text-neutral-400">
                                              {' '}
                                              · {d.platform}
                                            </span>
                                          ) : null}
                                          {d.name_custom ? (
                                            <span
                                              title={t('plugins.nameCustomHint')}
                                              className="ml-1.5 text-[10px] text-brand-600 border border-brand-200 rounded px-1"
                                            >
                                              {t('plugins.nameCustomBadge')}
                                            </span>
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
                                      </>
                                    )}
                                  </div>
                                  <div className="shrink-0 flex items-center gap-1.5">
                                    {editing ? (
                                      <>
                                        <button
                                          onClick={() =>
                                            renameDevice(s.plugin_id, d.device_id, renameValue)
                                          }
                                          disabled={rowBusy || !renameValue.trim()}
                                          className="text-[11px] text-white bg-brand-600 rounded-md px-2 py-1 hover:bg-brand-700 disabled:opacity-50"
                                        >
                                          {rowBusy ? t('plugins.saving') : t('plugins.renameSave')}
                                        </button>
                                        <button
                                          onClick={() => {
                                            setRenameKey(null);
                                            setRenameValue('');
                                          }}
                                          disabled={rowBusy}
                                          className="text-[11px] text-neutral-500 border border-neutral-200 rounded-md px-2 py-1 hover:bg-neutral-100 disabled:opacity-50"
                                        >
                                          {t('plugins.renameCancel')}
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <button
                                          onClick={() => {
                                            setRenameKey(rowKey);
                                            setRenameValue(d.device_name || '');
                                          }}
                                          className="text-[11px] text-brand-600 border border-brand-200 rounded-md px-2 py-1 hover:bg-brand-50"
                                        >
                                          {t('plugins.rename')}
                                        </button>
                                        <button
                                          onClick={() => revokeDevice(s.plugin_id, d.device_id)}
                                          disabled={rowBusy}
                                          className="text-[11px] text-red-600 border border-red-200 rounded-md px-2 py-1 hover:bg-red-50 disabled:opacity-50"
                                        >
                                          {rowBusy ? t('plugins.revoking') : t('plugins.revoke')}
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
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
                  {/* cancelled 后不再显示「取消订阅」：再点一次毫无意义，只会让用户
                      以为上次没生效。想恢复就点「续费」（会顺延，不吞剩余天数）。 */}
                  {s.status === 'active' && valid && (
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
