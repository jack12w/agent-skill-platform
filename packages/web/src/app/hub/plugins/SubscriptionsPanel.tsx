'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

/** 插件下拉用的最小字段（父组件传进来，省一次请求） */
export interface PluginOption {
  id: string;
  name: string;
  slug: string;
}

/** 后端 GET :id/subscriptions 返回的行（raw join，含用户信息） */
interface SubRow {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  price_cents: number | string;
  started_at: string;
  expires_at: string;
  /** 有值 = 由支付订单产生；为空 = 手动添加（后端不再额外加列，靠这个天然区分） */
  order_id: string | null;
  user_email: string | null;
  user_name: string | null;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
}

const PRESET_DAYS = [7, 30, 90, 365];
const PAGE_SIZE = 20;

function getToken(): string | null {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

/** ISO → 本地「YYYY-MM-DD HH:mm」 */
function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO → <input type="date"> 的本地日 */
function toDateInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 选中的「到期日」→ 东八区当日 23:59:59。
 * 不能直接提交 'YYYY-MM-DD'：那会被按 UTC 00:00 解析，北京时间当天 08:00 就过期了。
 */
function dayToCnEndOfDay(day: string): string {
  return `${day}T23:59:59+08:00`;
}

export default function SubscriptionsPanel({ plugins }: { plugins: PluginOption[] }) {
  const { t } = useTranslation();

  const [pluginId, setPluginId] = useState('');
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [subLoading, setSubLoading] = useState(false);
  const [subErr, setSubErr] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // 添加区
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<UserRow[]>([]);
  const [pickedUser, setPickedUser] = useState<UserRow | null>(null);
  const [mode, setMode] = useState<'days' | 'date'>('days');
  const [days, setDays] = useState('30');
  const [pickDate, setPickDate] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState('');
  const [addOk, setAddOk] = useState('');

  // 行内改到期时间
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState('');

  const field =
    'w-full px-2.5 py-1.5 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:border-brand-400';

  /** 默认选第一个插件，避免进来是一片空白 */
  useEffect(() => {
    if (!pluginId && plugins.length > 0) setPluginId(plugins[0].id);
  }, [plugins, pluginId]);

  const loadSubs = useCallback(async () => {
    if (!pluginId) return;
    const token = getToken();
    if (!token) return;
    setSubLoading(true);
    setSubErr('');
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('search', search.trim());
      if (statusFilter) qs.set('status', statusFilter);
      qs.set('page', String(page));
      qs.set('size', String(PAGE_SIZE));
      const res = await fetch(`/api/admin/plugins/${pluginId}/subscriptions?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setSubs(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
    } catch {
      // ⚠️ 失败**绝不**清空列表：保留旧数据 + 报错，否则一次网络抖动就把整页清空
      setSubErr(t('admin.subLoadFailed'));
    } finally {
      setSubLoading(false);
    }
  }, [pluginId, search, statusFilter, page, t]);

  useEffect(() => {
    loadSubs();
  }, [loadSubs]);

  /** 换插件要重置分页，否则会停在上一个插件的第 N 页 */
  const changePlugin = (id: string) => {
    setPluginId(id);
    setPage(1);
    setEditingId(null);
    setRowErr('');
  };

  /** 用户搜索（400ms 防抖）；失败保留上次结果，不清空 */
  useEffect(() => {
    const kw = userQuery.trim();
    if (!kw) {
      setUserResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      try {
        const res = await fetch(
          `/api/admin/users?search=${encodeURIComponent(kw)}&size=10`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;
        const data = await res.json();
        setUserResults(Array.isArray(data?.items) ? data.items : []);
      } catch {
        /* 保留上次结果 */
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [userQuery]);

  const addSub = async () => {
    setAddErr('');
    setAddOk('');
    if (!pluginId) return;
    if (!pickedUser) {
      setAddErr(t('admin.subNeedUser'));
      return;
    }
    const body: Record<string, unknown> = { user_id: pickedUser.id };
    if (mode === 'days') {
      const d = Math.floor(Number(days));
      if (!Number.isFinite(d) || d <= 0) {
        setAddErr(t('admin.subNeedDays'));
        return;
      }
      body.days = d;
    } else {
      if (!pickDate) {
        setAddErr(t('admin.subNeedDate'));
        return;
      }
      body.expires_at = dayToCnEndOfDay(pickDate);
    }

    const token = getToken();
    if (!token) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/plugins/${pluginId}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || String(res.status));
      setAddOk(t('admin.subAdded'));
      setPickedUser(null);
      setUserQuery('');
      setUserResults([]);
      setPage(1);
      await loadSubs();
    } catch (e: any) {
      setAddErr(e?.message || t('admin.subActionFailed'));
    } finally {
      setAdding(false);
    }
  };

  const saveExpiry = async (sub: SubRow) => {
    if (!editDate) return;
    const token = getToken();
    if (!token) return;
    setSavingRow(sub.id);
    setRowErr('');
    try {
      const res = await fetch(
        `/api/admin/plugins/${pluginId}/subscriptions/${sub.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ expires_at: dayToCnEndOfDay(editDate) }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || String(res.status));
      setEditingId(null);
      await loadSubs();
    } catch (e: any) {
      setRowErr(e?.message || t('admin.subActionFailed'));
    } finally {
      setSavingRow(null);
    }
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      active: 'bg-green-100 text-green-700',
      expired: 'bg-neutral-100 text-neutral-500',
      cancelled: 'bg-red-50 text-red-600',
    };
    const label =
      s === 'active'
        ? t('admin.subStatusActive')
        : s === 'expired'
          ? t('admin.subStatusExpired')
          : t('admin.subStatusCancelled');
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[s] || map.expired}`}>
        {label}
      </span>
    );
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isExpired = (iso: string) => new Date(iso).getTime() <= Date.now();

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">{t('admin.subDesc')}</p>

      {/* 筛选区 */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-neutral-500">{t('admin.subPickPlugin')}</span>
          <select
            className={`${field} min-w-[16rem]`}
            value={pluginId}
            onChange={(e) => changePlugin(e.target.value)}
          >
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.slug}）
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">{t('admin.subFilterUser')}</span>
          <input
            className={`${field} min-w-[14rem]`}
            placeholder={t('admin.subUserPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-500">{t('admin.thStatus')}</span>
          <select
            className={field}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('admin.subStatusAll')}</option>
            <option value="active">{t('admin.subStatusActive')}</option>
            <option value="expired">{t('admin.subStatusExpired')}</option>
            <option value="cancelled">{t('admin.subStatusCancelled')}</option>
          </select>
        </label>
        <span className="text-xs text-neutral-400 pb-1.5">
          {t('admin.subTotal')} {total}
        </span>
      </div>

      {plugins.length === 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl px-4 py-10 text-center text-sm text-neutral-400">
          {t('admin.noPlugins')}
        </div>
      )}

      {/* 添加 / 续期 */}
      {plugins.length > 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <div className="text-sm font-medium text-neutral-800 mb-3">
            {t('admin.subAddTitle')}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-neutral-500">{t('admin.subUserSearch')}</span>
              {pickedUser ? (
                <div className="mt-1 flex items-center justify-between gap-2 bg-brand-50 border border-brand-100 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-neutral-800 truncate">
                      {pickedUser.name || pickedUser.email || pickedUser.id}
                    </div>
                    <div className="text-[11px] text-neutral-400 truncate">
                      {pickedUser.email || pickedUser.id}
                    </div>
                  </div>
                  <button
                    onClick={() => setPickedUser(null)}
                    className="text-xs text-neutral-500 hover:text-neutral-800 shrink-0"
                  >
                    {t('admin.subChangeUser')}
                  </button>
                </div>
              ) : (
                <>
                  <input
                    className={`${field} mt-1`}
                    placeholder={t('admin.subUserPlaceholder')}
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                  />
                  {userQuery.trim() && (
                    <div className="mt-1 border border-neutral-200 rounded-lg divide-y divide-neutral-100 max-h-44 overflow-y-auto">
                      {userResults.map((u) => (
                        <button
                          key={u.id}
                          onClick={() => {
                            setPickedUser(u);
                            setUserQuery('');
                            setUserResults([]);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-neutral-50"
                        >
                          <div className="text-sm text-neutral-800 truncate">
                            {u.name || u.email || u.id}
                          </div>
                          <div className="text-[11px] text-neutral-400 truncate">{u.email}</div>
                        </button>
                      ))}
                      {userResults.length === 0 && (
                        <div className="px-3 py-2 text-xs text-neutral-400">
                          {t('admin.subNoUserFound')}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div>
              <span className="text-xs text-neutral-500">{t('admin.subAddDuration')}</span>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-neutral-200 overflow-hidden">
                  <button
                    onClick={() => setMode('days')}
                    className={`px-3 py-1.5 text-xs ${
                      mode === 'days' ? 'bg-brand-600 text-white' : 'bg-white text-neutral-600'
                    }`}
                  >
                    {t('admin.subModeDays')}
                  </button>
                  <button
                    onClick={() => setMode('date')}
                    className={`px-3 py-1.5 text-xs ${
                      mode === 'date' ? 'bg-brand-600 text-white' : 'bg-white text-neutral-600'
                    }`}
                  >
                    {t('admin.subModeDate')}
                  </button>
                </div>

                {mode === 'days' ? (
                  <>
                    {PRESET_DAYS.map((d) => (
                      <button
                        key={d}
                        onClick={() => setDays(String(d))}
                        className={`px-2.5 py-1.5 text-xs rounded-lg border ${
                          Number(days) === d
                            ? 'border-brand-400 bg-brand-50 text-brand-700'
                            : 'border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        +{d}
                      </button>
                    ))}
                    <input
                      className={`${field} w-24`}
                      type="number"
                      min="1"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                    />
                    <span className="text-xs text-neutral-400">{t('admin.subDaysUnit')}</span>
                  </>
                ) : (
                  <>
                    <input
                      className={`${field} w-44`}
                      type="date"
                      value={pickDate}
                      onChange={(e) => setPickDate(e.target.value)}
                    />
                    <span className="text-xs text-neutral-400">{t('admin.subDateHint')}</span>
                  </>
                )}
              </div>

              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={addSub}
                  disabled={adding}
                  className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
                >
                  {adding ? t('admin.subAdding') : t('admin.subAdd')}
                </button>
                {addOk && <span className="text-xs text-green-600">{addOk}</span>}
                {addErr && <span className="text-xs text-red-600">{addErr}</span>}
              </div>
            </div>
          </div>

          <p className="mt-3 text-[11px] text-neutral-400">{t('admin.subAddHint')}</p>
          <p className="mt-1 text-[11px] text-amber-600">{t('admin.subDelayHint')}</p>
        </div>
      )}

      {/* 列表 */}
      {plugins.length > 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto">
          {subErr && <div className="px-4 py-2 text-xs text-red-600 border-b border-neutral-100">{subErr}</div>}
          {rowErr && <div className="px-4 py-2 text-xs text-red-600 border-b border-neutral-100">{rowErr}</div>}
          {subLoading && (
            <div className="px-4 py-2 text-xs text-neutral-400 border-b border-neutral-100">
              {t('admin.loading')}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">{t('admin.subThUser')}</th>
                <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
                <th className="px-4 py-3 text-left">{t('admin.subThExpires')}</th>
                <th className="px-4 py-3 text-center hidden md:table-cell">{t('admin.subThSource')}</th>
                <th className="px-4 py-3 text-right">{t('admin.subThActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {subs.map((s) => (
                <tr key={s.id} className="hover:bg-neutral-50 align-top">
                  <td className="px-4 py-3">
                    <div className="text-neutral-900 font-medium truncate max-w-[18rem]">
                      {s.user_name || s.user_email || s.user_id}
                    </div>
                    {s.user_email && (
                      <div className="text-xs text-neutral-400 truncate max-w-[18rem]">
                        {s.user_email}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">{statusBadge(s.status)}</td>
                  <td className="px-4 py-3">
                    <div className="tabular-nums text-neutral-800">{fmtDateTime(s.expires_at)}</div>
                    {isExpired(s.expires_at) && s.status === 'active' && (
                      <div className="text-[11px] text-amber-600">{t('admin.subPastDue')}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center hidden md:table-cell">
                    <span
                      className={`text-xs ${
                        s.order_id ? 'text-neutral-500' : 'text-brand-600'
                      }`}
                    >
                      {s.order_id ? t('admin.subSourcePaid') : t('admin.subSourceManual')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {editingId === s.id ? (
                      <div className="inline-flex items-center gap-2">
                        <input
                          className={`${field} w-40`}
                          type="date"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                        />
                        <button
                          onClick={() => saveExpiry(s)}
                          disabled={savingRow === s.id}
                          className="text-xs text-brand-600 hover:underline disabled:opacity-40"
                        >
                          {t('admin.save')}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-xs text-neutral-500 hover:underline"
                        >
                          {t('admin.cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingId(s.id);
                          setEditDate(toDateInput(s.expires_at));
                          setRowErr('');
                        }}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        {t('admin.subEditExpiry')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {subs.length === 0 && !subLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-neutral-400 text-sm">
                    {t('admin.subNoSubs')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-neutral-100 flex items-center justify-end gap-2 text-xs">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-2 py-1 border border-neutral-200 rounded disabled:opacity-40"
              >
                {t('admin.prevPage')}
              </button>
              <span className="text-neutral-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-2 py-1 border border-neutral-200 rounded disabled:opacity-40"
              >
                {t('admin.nextPage')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
