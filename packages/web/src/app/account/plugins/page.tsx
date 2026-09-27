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

/**
 * 账户页统一请求入口：自动带 token + **强制禁用 HTTP 缓存**。
 *
 * ⚠️ `cache: 'no-store'` 不是可选优化，是本页的正确性前提。
 * 2026-09-27 生产实测：用户点「解绑设备」→ 服务端确实写入了 `revoked_at`
 * （库里可查证），但页面计数与设备列表**纹丝不动**，用户看到的是
 * 「已解绑该设备」的黄色提示 + 仍旧 `已授权 1/1 台设备`。
 * 根因：`GET /plugins/:id/devices` 的响应没有任何 `Cache-Control`，
 * 浏览器按**启发式缓存**复用了之前那份快照，`loadDevices()` 拿回的是解绑
 * **之前**的数据 —— 用户视角就是「解绑无效 / 点了没反应」。
 *
 * 凡是「写操作之后要立刻读回」的接口（设备列表、我的订阅），一律不得读缓存。
 */
function apiFetch(url: string, init: RequestInit = {}) {
  return fetch(url, {
    cache: 'no-store',
    ...init,
    headers: { ...authHeaders(), ...((init.headers as Record<string, string>) || {}) },
  });
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
        apiFetch('/api/plugins/mine'),
        apiFetch('/api/plugins'),
      ]);
      // 失败时保留旧数据，绝不用空数组覆盖（否则一次抖动会把列表清空）
      if (mineRes.ok) {
        const mine: MySub[] = await mineRes.json();
        setSubs(mine);
        setError(null);
        /* 2026-09-27 预取设备数：设备数据以前是「展开面板才拉」，于是收起状态下
         * 「已授权 N/M 台设备」只能显示兜底值 `?? 0` / `?? 2` —— 用户看到「0/2」，
         * 点开却变成真实的「1/1」，第一反应是「数字不对/有 bug」。
         * 这里对所有**权益仍有效**的订阅各拉一次（只读接口），让收起时也是真值；
         * 失效订阅那块面板本来就不渲染，不请求。 */
        preloadDevices(mine.filter((s) => isEntitled(s)).map((s) => s.plugin_id));
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
      const res = await apiFetch(`/api/plugins/${pluginId}/devices`);
      if (res.ok) {
        const data = await res.json();
        setDeviceData((prev) => ({ ...prev, [pluginId]: data }));
      } else {
        // 拉取失败必须说出来：否则面板显示空态，用户会以为「设备被清空了」
        setNotice(t('plugins.devicesLoadFailed', { code: res.status }));
      }
    } catch {
      setNotice(t('plugins.devicesLoadFailed', { code: t('plugins.networkError') }));
    } finally {
      setDeviceLoading(null);
    }
  };

  /**
   * 预取设备数（收起状态下也要显示真值）。
   *
   * 与 loadDevices 的差异：**不碰 deviceLoading**。展开面板时才需要 loading 观感；
   * 页面初始化时若把每个插件都置成 loading，会让「管理设备」点开一瞬间闪一下空态。
   * 单个失败静默 —— 计数退回兜底值，展开时还有一次真实请求兜着。
   */
  const preloadDevices = async (pluginIds: string[]) => {
    await Promise.all(
      pluginIds.map(async (pluginId) => {
        try {
          const res = await apiFetch(`/api/plugins/${pluginId}/devices`);
          if (!res.ok) return;
          const data = await res.json();
          setDeviceData((prev) => ({ ...prev, [pluginId]: data }));
        } catch {
          /* 静默：展开时再拉 */
        }
      }),
    );
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
      const res = await apiFetch(`/api/plugins/${pluginId}/cancel`, {
        method: 'POST',
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
      const res = await apiFetch(
        `/api/plugins/${pluginId}/devices/${encodeURIComponent(deviceId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
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

  /**
   * 解绑一台设备。
   *
   * ⚠️ 2026-09-27：失败必须说出来。旧实现是 `if (res.ok) await loadDevices(...)`，
   * 失败路径完全静默 —— 用户点了「解绑」，页面一动不动、没有任何提示，
   * 既不知道是没解绑成功还是界面没刷新，插件那边也还持有有效令牌继续能用。
   * 现在按 HTTP 状态码给可操作文案（与 cancel / rename 同一条约定）。
   */
  const revokeDevice = async (pluginId: string, deviceId: string) => {
    if (!confirm(t('plugins.revokeConfirm'))) return;
    setDeviceBusy(`${pluginId}:${deviceId}`);
    try {
      const res = await apiFetch(
        `/api/plugins/${pluginId}/devices/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        await loadDevices(pluginId);
        setNotice(t('plugins.revokeDone'));
      } else if (res.status === 404) {
        // 常见于「这份记录已经不在库里了」：本地列表过期，刷新一次即为最新
        await loadDevices(pluginId);
        setNotice(t('plugins.revokeGone'));
      } else {
        setNotice(t('plugins.revokeFailed', { code: res.status }));
      }
    } catch {
      setNotice(t('plugins.revokeFailed', { code: t('plugins.networkError') }));
    } finally {
      setDeviceBusy(null);
    }
  };

  const revokeAll = async (pluginId: string) => {
    if (!confirm(t('plugins.resetDevicesConfirm'))) return;
    setDeviceBusy(`${pluginId}:all`);
    try {
      const res = await apiFetch(`/api/plugins/${pluginId}/reset-devices`, {
        method: 'POST',
      });
      if (res.ok) {
        await loadDevices(pluginId);
        setNotice(t('plugins.revokeAllDone'));
      } else {
        setNotice(t('plugins.revokeFailed', { code: res.status }));
      }
    } catch {
      setNotice(t('plugins.revokeFailed', { code: t('plugins.networkError') }));
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
                          {/* 设备数没拿到之前**不要**写「0/2」——那是在陈述一个错误事实
                              （明明有 1 台授权，却显示 0 台），用户会当成 bug 来报。
                              改成「加载中」，拿到真值再落数。 */}
                          {dd
                            ? t('plugins.devicesUsed', {
                                n: dd.devices?.length ?? 0,
                                max: dd.max_devices,
                              })
                            : t('plugins.devicesUsedLoading')}
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
