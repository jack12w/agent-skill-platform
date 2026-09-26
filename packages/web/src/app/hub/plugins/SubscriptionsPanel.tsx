'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import SubFormModal from './SubFormModal';
import {
  PAGE_SIZE,
  fmtDateTime,
  getToken,
  isPast,
  statusBadgeClass,
  type SubRow,
} from './subscriptions-shared';

/** 插件下拉用的最小字段（父组件传进来，省一次请求） */
export interface PluginOption {
  id: string;
  name: string;
  slug: string;
}

type ModalState = { mode: 'add' } | { mode: 'edit'; sub: SubRow } | null;

export default function SubscriptionsPanel({ plugins }: { plugins: PluginOption[] }) {
  const { t } = useTranslation();

  const [pluginId, setPluginId] = useState('');
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [subLoading, setSubLoading] = useState(false);
  const [subErr, setSubErr] = useState('');
  const [flash, setFlash] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  /** 新增 / 编辑共用一个弹窗 */
  const [modal, setModal] = useState<ModalState>(null);

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
    setModal(null);
    setFlash('');
  };

  const openModal = (next: ModalState) => {
    setModal(next);
    setFlash('');
  };

  /** 弹窗保存成功：关窗 → 提示 → 刷新列表 */
  const handleSaved = async () => {
    const wasAdd = modal?.mode === 'add';
    setModal(null);
    setFlash(wasAdd ? t('admin.subAdded') : t('admin.subUpdated'));
    if (wasAdd && page !== 1) {
      // 新增的用户未必在当前页，回到第 1 页（setPage 会触发 effect 重新拉取）
      setPage(1);
      return;
    }
    await loadSubs();
  };

  const statusBadge = (s: string) => {
    const label =
      s === 'active'
        ? t('admin.subStatusActive')
        : s === 'expired'
          ? t('admin.subStatusExpired')
          : t('admin.subStatusCancelled');
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(s)}`}>
        {label}
      </span>
    );
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">{t('admin.subDesc')}</p>

      {/* 筛选区 + 新增入口 */}
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

        {plugins.length > 0 && (
          <button
            onClick={() => openModal({ mode: 'add' })}
            className="ml-auto px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700"
          >
            + {t('admin.subAddTitle')}
          </button>
        )}
      </div>

      {plugins.length === 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl px-4 py-10 text-center text-sm text-neutral-400">
          {t('admin.noPlugins')}
        </div>
      )}

      {/* 列表 */}
      {plugins.length > 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto">
          {subErr && (
            <div className="px-4 py-2 text-xs text-red-600 border-b border-neutral-100">{subErr}</div>
          )}
          {flash && (
            <div className="px-4 py-2 text-xs text-green-600 border-b border-neutral-100">
              {flash}
            </div>
          )}
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
                    {isPast(s.expires_at) && s.status === 'active' && (
                      <div className="text-[11px] text-amber-600">{t('admin.subPastDue')}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center hidden md:table-cell">
                    <span
                      className={`text-xs ${s.order_id ? 'text-neutral-500' : 'text-brand-600'}`}
                    >
                      {s.order_id ? t('admin.subSourcePaid') : t('admin.subSourceManual')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => openModal({ mode: 'edit', sub: s })}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {t('admin.subEdit')}
                    </button>
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

      {modal && (
        <SubFormModal
          mode={modal.mode}
          pluginId={pluginId}
          sub={modal.mode === 'edit' ? modal.sub : undefined}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
