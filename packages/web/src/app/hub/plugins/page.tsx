'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import Modal from '../../components/Modal';
import SubscriptionsPanel from './SubscriptionsPanel';
import AiDataPanel from './AiDataPanel';
import AiTypesPanel from './AiTypesPanel';

interface PluginItem {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  icon_url: string | null;
  category: string;
  price_monthly_cents: number;
  list_price_monthly_cents: number | null;
  promo_ends_at: string | null;
  features: string[] | null;
  currency: string;
  status: string;
  sort_order: number;
  max_activations: number;
  /** 订阅有效期（天）：本款插件新开/续费订阅的默认时长 */
  subscription_duration_days: number;
  /* ── 0041（2026-10-28）：商品类型 / 档位归属 / 限购 / 续费 ── */
  /** standard=独立商品 / tier=价格档位 / trial=试用 */
  kind: 'standard' | 'tier' | 'trial';
  /** 权益归属的主插件 id（tier/trial 必填） */
  parent_plugin_id: string | null;
  /** 每用户限购次数；null = 不限 */
  max_purchases_per_user: number | null;
  /** 是否允许在账号中心续费（试用恒为 false） */
  renew_allowed: boolean;
  download_key: string | null;
  download_filename: string | null;
  /** 订阅数：订阅过该商品的去重用户数（含已过期、含手动开通）；团队行按团长算 1 个客户 */
  user_count: number;
  created_at: string;
  updated_at: string;
}

interface FormState {
  name: string;
  slug: string;
  category: string;
  tagline: string;
  description: string;
  icon_url: string;
  priceYuan: string;
  listPriceYuan: string;
  promoEndsAt: string;
  featuresText: string;
  sort_order: string;
  max_activations: string;
  subscription_duration_days: string;
  status: string;
  download_key: string;
  download_filename: string;
  /** 0041：商品类型 / 所属主插件 / 限购次数 / 允许续费 */
  kind: 'standard' | 'tier' | 'trial';
  parent_plugin_id: string;
  /** 空字符串＝不限购（不是 0，0 会被当成非法值） */
  max_purchases_per_user: string;
  renew_allowed: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  slug: '',
  category: '通用',
  tagline: '',
  description: '',
  icon_url: '',
  priceYuan: '',
  listPriceYuan: '',
  promoEndsAt: '',
  featuresText: '',
  sort_order: '0',
  max_activations: '1',
  subscription_duration_days: '30',
  status: 'active',
  download_key: '',
  download_filename: '',
  kind: 'standard',
  parent_plugin_id: '',
  max_purchases_per_user: '',
  renew_allowed: true,
};

/** ISO → 本地 datetime-local 输入值（YYYY-MM-DDTHH:mm） */
function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 元字符串 → 分；空/非法 → null（而不是 0，避免把「不设置」写成 ¥0） */
function yuanToCentsOrNull(v: string): number | null {
  const s = (v || '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function getToken() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

export default function HubPluginsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<PluginItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  /** 顶部 tab：插件管理 / 订阅管理 / 插件数据（订阅面板复用同一份插件列表，不再重复请求） */
  const [tab, setTab] = useState<'plugins' | 'subs' | 'data'>('plugins');
  /** 「插件数据」内子 tab：数据看板 / 类型注册表（计划 v2.4） */
  const [dataTab, setDataTab] = useState<'board' | 'types'>('board');

  /** 「订阅用户」弹窗状态（点击列表里的订阅数打开） */
  const [usersOpen, setUsersOpen] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersPlugin, setUsersPlugin] = useState<PluginItem | null>(null);
  const [usersSearch, setUsersSearch] = useState('');
  /** 2026-10-12 三轮质检：「订阅用户」弹窗的加载错误（原实现失败时静默置空列表） */
  const [usersErr, setUsersErr] = useState('');

  const loadUsers = useCallback(
    async (pluginId: string, page: number, search: string) => {
      const token = getToken();
      if (!token) return;
      setUsersLoading(true);
      setUsersErr('');
      try {
        const params = new URLSearchParams({ page: String(page), size: '50', search });
        const res = await fetch(`/api/admin/plugins/${pluginId}/users?${params.toString()}`, {
          // 与后端 no-store 呼应：避免磁盘缓存复用旧快照
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setUsers(data.items || []);
        setUsersTotal(data.total || 0);
      } catch {
        // 2026-10-12 三轮质检：原实现失败时 `setUsers([])` —— 把「加载失败」伪装成
        // 「该插件没有用户」，运营据此误判。改为保留旧数据 + 显式报错。
        setUsersErr(t('admin.usersLoadFailed'));
      } finally {
        setUsersLoading(false);
      }
    },
    [t],
  );

  const openUsers = (p: PluginItem) => {
    setUsersPlugin(p);
    setUsersOpen(true);
    setUsers([]);
    setUsersTotal(0);
    setUsersSearch('');
    loadUsers(p.id, 1, '');
  };

  const fetchData = useCallback(async () => {
    const token = getToken();
    if (!token) {
      // 2026-10-12 三轮质检：原实现在此直接 return，而 loading 初始态为 true →
      // 登录态失效（localStorage 无 token）时整页**永久卡在 spinner**，且不提示登录，
      // 管理员无法自救。改为结束 loading + 明确提示。
      setLoading(false);
      setErr(t('admin.notLoggedIn'));
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/plugins', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      setItems(await res.json());
    } catch {
      setErr(t('admin.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErr('');
    setUploadErr('');
    setModalOpen(true);
  };

  const openEdit = (p: PluginItem) => {
    setEditingId(p.id);
    setForm({
      name: p.name || '',
      slug: p.slug || '',
      category: p.category || '通用',
      tagline: p.tagline || '',
      description: p.description || '',
      icon_url: p.icon_url || '',
      priceYuan: p.price_monthly_cents ? String(p.price_monthly_cents / 100) : '',
      listPriceYuan: p.list_price_monthly_cents
        ? String(p.list_price_monthly_cents / 100)
        : '',
      promoEndsAt: toLocalInput(p.promo_ends_at),
      featuresText: (p.features || []).join('\n'),
      sort_order: String(p.sort_order ?? 0),
      max_activations: String(p.max_activations ?? 2),
      subscription_duration_days: String(p.subscription_duration_days ?? 30),
      status: p.status || 'active',
      download_key: p.download_key || '',
      download_filename: p.download_filename || '',
      kind: p.kind || 'standard',
      parent_plugin_id: p.parent_plugin_id || '',
      max_purchases_per_user:
        p.max_purchases_per_user == null ? '' : String(p.max_purchases_per_user),
      renew_allowed: p.renew_allowed !== false,
    });
    setErr('');
    setUploadErr('');
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setErr(t('admin.nameRequired'));
      return;
    }
    const token = getToken();
    if (!token) return;
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      category: form.category.trim() || '通用',
      tagline: form.tagline.trim() || null,
      description: form.description.trim() || null,
      icon_url: form.icon_url.trim() || null,
      price_monthly_cents: Math.max(0, Math.round(Number(form.priceYuan || 0) * 100)),
      // 原价空值必须传 null（传 0 会被当成「原价 ¥0」，虽然后端会过滤，但语义要干净）
      list_price_monthly_cents: yuanToCentsOrNull(form.listPriceYuan),
      promo_ends_at: form.promoEndsAt
        ? new Date(form.promoEndsAt).toISOString()
        : null,
      features: form.featuresText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      sort_order: Number(form.sort_order) || 0,
      // 默认 1：这个数字是「可授权账号数」，≥2 即团队档（自动建团 + 开 AI）——
      // 新品默认给 2 等于「一建就是团队版」，是运营最容易踩的一脚。
      max_activations: Math.max(1, Math.round(Number(form.max_activations) || 1)),
      subscription_duration_days: Math.max(
        1,
        Math.round(Number(form.subscription_duration_days) || 30),
      ),
      status: form.status,
      download_key: form.download_key.trim() || null,
      download_filename: form.download_filename.trim() || null,
      /* 0041：商品类型与档位归属。parent 只在 tier/trial 时提交，
         standard 显式传 null（后端据此清空，避免遗留的错误归属）。 */
      kind: form.kind,
      parent_plugin_id: form.kind === 'standard' ? null : form.parent_plugin_id || null,
      max_purchases_per_user: form.max_purchases_per_user.trim()
        ? Math.max(1, Math.round(Number(form.max_purchases_per_user) || 1))
        : null,
      renew_allowed: form.renew_allowed,
    };
    if (form.slug.trim()) payload.slug = form.slug.trim().toLowerCase();

    setSaving(true);
    setErr('');
    try {
      const res = await fetch(
        editingId ? `/api/admin/plugins/${editingId}` : '/api/admin/plugins',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const msg = await res.json().catch(() => null);
        throw new Error(msg?.message || String(res.status));
      }
      setModalOpen(false);
      await fetchData();
    } catch (e: any) {
      setErr(e?.message || t('admin.loadFailed'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 上传安装包 → OSS `plugins/{slug}/client.{zip|crx}`，成功后回填 download_key / download_filename。
   * 刻意不自动保存商品：用户还能接着改别的字段再点保存；取消保存也不会写脏数据
   * （顶多在 OSS 上留一个对象，同 slug 重传会被同名覆盖，不累积）。
   */
  const uploadPackage = async (file: File) => {
    setUploadErr('');
    const slug = form.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      setUploadErr(t('admin.uploadNeedSlug'));
      return;
    }
    if (!/\.(zip|crx)$/i.test(file.name)) {
      setUploadErr(t('admin.uploadBadType'));
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setUploadErr(t('admin.uploadTooLarge'));
      return;
    }
    const token = getToken();
    if (!token) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('slug', slug);
      // 服务端 multer 的 originalname 按 latin1 解码、中文会乱码 → 再显式传一份 UTF-8 文件名
      fd.append('filename', file.name);
      const res = await fetch('/api/admin/plugins/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || String(res.status));
      setForm((f) => ({
        ...f,
        download_key: data?.download_key || '',
        download_filename: data?.download_filename || file.name,
      }));
    } catch (e: any) {
      setUploadErr(e?.message || t('admin.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const toggleStatus = async (p: PluginItem) => {
    const token = getToken();
    if (!token) return;
    setBusyId(p.id);
    try {
      const res = await fetch(`/api/admin/plugins/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: p.status === 'active' ? 'hidden' : 'active' }),
      });
      if (res.ok) await fetchData();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (p: PluginItem) => {
    if (!confirm(t('admin.confirmDeletePlugin'))) return;
    const token = getToken();
    if (!token) return;
    setBusyId(p.id);
    setErr('');
    try {
      const res = await fetch(`/api/admin/plugins/${p.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => null);
        throw new Error(msg?.message || String(res.status));
      }
      await fetchData();
    } catch (e: any) {
      setErr(e?.message || t('admin.loadFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const fmtPrice = (cents: number) =>
    `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  const field = 'w-full px-2.5 py-1.5 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:border-brand-400';

  return (
    <div className="max-w-full">
      <h1 className="text-xl font-bold text-neutral-900 mb-1">{t('admin.plugins')}</h1>
      <p className="text-sm text-neutral-500">{t('admin.pluginsDesc')}</p>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 mt-4 border-b border-neutral-200">
        {(
          [
            ['plugins', t('admin.tabPlugins')],
            ['subs', t('admin.tabSubscriptions')],
            ['data', t('admin.tabData')],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${
              tab === k
                ? 'border-brand-600 text-brand-700 font-medium'
                : 'border-transparent text-neutral-500 hover:text-neutral-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'data' && (
        <div className="mt-4">
          {/* 子 TAB：数据看板 | 类型注册表（右侧） */}
          <div className="flex items-center gap-1 mb-4 border-b border-neutral-100">
            {(
              [
                ['board', t('admin.aiSubTabBoard')],
                ['types', t('admin.aiSubTabTypes')],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setDataTab(k)}
                className={`px-3 py-1.5 text-sm -mb-px border-b-2 ${
                  dataTab === k
                    ? 'border-brand-600 text-brand-700 font-medium'
                    : 'border-transparent text-neutral-500 hover:text-neutral-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {dataTab === 'types' ? <AiTypesPanel /> : <AiDataPanel />}
        </div>
      )}

      {tab === 'subs' && (
        <div className="mt-4">
          <SubscriptionsPanel plugins={items} />
        </div>
      )}

      {tab === 'plugins' && (
        <>
      <div className="flex items-center gap-3 my-4">
        <button
          onClick={openCreate}
          className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          + {t('admin.addPlugin')}
        </button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      ) : (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">{t('admin.thName')}</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">{t('admin.thSlug')}</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">{t('admin.thCategory')}</th>
                <th className="px-4 py-3 text-right">{t('admin.thPrice')}</th>
                <th className="px-4 py-3 text-center hidden sm:table-cell">{t('admin.thOrder')}</th>
                <th
                  className="px-4 py-3 text-center hidden lg:table-cell"
                  title={t('admin.fieldMaxActivationsHint')}
                >
                  {t('admin.thDevices')}
                </th>
                <th className="px-4 py-3 text-center hidden lg:table-cell">{t('admin.thUserCount')}</th>
                <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
                <th className="px-4 py-3 text-right">{t('admin.thActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {items.map((p) => (
                <tr key={p.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-neutral-900">{p.name}</div>
                    {p.tagline && (
                      <div className="text-xs text-neutral-400 truncate max-w-[26rem]">{p.tagline}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-500 hidden md:table-cell">
                    <code className="text-xs">{p.slug}</code>
                  </td>
                  <td className="px-4 py-3 text-neutral-600 hidden lg:table-cell">{p.category}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {!!p.list_price_monthly_cents &&
                      p.list_price_monthly_cents > p.price_monthly_cents && (
                        <span className="mr-1.5 text-xs text-neutral-400 line-through">
                          {fmtPrice(p.list_price_monthly_cents)}
                        </span>
                      )}
                    <span className="font-medium">{fmtPrice(p.price_monthly_cents)}</span>
                    {!!p.promo_ends_at &&
                      new Date(p.promo_ends_at).getTime() <= Date.now() && (
                        <div className="text-[11px] text-amber-600">
                          {t('admin.promoExpired')}
                        </div>
                      )}
                  </td>
                  <td className="px-4 py-3 text-center text-neutral-500 hidden sm:table-cell">{p.sort_order}</td>
                  <td className="px-4 py-3 text-center text-neutral-500 hidden lg:table-cell">
                    {p.max_activations ?? 1}
                  </td>
                  <td className="px-4 py-3 text-center hidden lg:table-cell">
                    {/* 订阅数 = 订阅过该商品的去重用户数（含已过期、含手动开通），
                        团队行按团长算 1 个客户。点开看具体名单。 */}
                    <button
                      onClick={() => openUsers(p)}
                      title={t('admin.usersTitle')}
                      className="text-brand-600 hover:underline font-medium tabular-nums"
                    >
                      {p.user_count ?? 0}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        p.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {p.status === 'active' ? t('admin.statusActive') : t('admin.statusHidden')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(p)} className="text-xs text-brand-600 hover:underline">
                      {t('admin.edit')}
                    </button>
                    <button
                      onClick={() => toggleStatus(p)}
                      disabled={busyId === p.id}
                      className="ml-3 text-xs text-amber-600 hover:underline disabled:opacity-40"
                    >
                      {p.status === 'active' ? t('admin.unpublish') : t('admin.publish')}
                    </button>
                    <button
                      onClick={() => remove(p)}
                      disabled={busyId === p.id}
                      className="ml-3 text-xs text-red-600 hover:underline disabled:opacity-40"
                    >
                      {t('admin.delete')}
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-neutral-400 text-sm">
                    {t('admin.noPlugins')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 新增 / 编辑 弹窗 */}
      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)} align="top" backdrop="bg-black/40">
          <div className="bg-white rounded-xl w-full max-w-2xl my-8 shadow-xl">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
              <h2 className="font-semibold text-neutral-900">
                {editingId ? t('admin.editPluginTitle') : t('admin.addPlugin')}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldName')} *</span>
                  <input
                    className={field}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldSlug')}</span>
                  <input
                    className={field}
                    placeholder="rfq-miner"
                    value={form.slug}
                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldCategory')}</span>
                  <input
                    className={field}
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  />
                </label>
                {/*
                  0041（2026-10-28）：商品类型。以前「是不是某个插件的档位/试用」靠 slug
                  前缀 `alibaba-toolkit-` 判断，运营把试用商品的 slug 填成 `7testing`
                  就整条链路失效（订阅落错行 → 扩展端查不到 → 用户付费后用不了）。
                  现在改成显式选择，选「试用」还会自动带上限购 1 次 + 不可续费。
                */}
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldKind')}</span>
                  <select
                    className={field}
                    value={form.kind}
                    onChange={(e) => {
                      const kind = e.target.value as FormState['kind'];
                      setForm((f) => ({
                        ...f,
                        kind,
                        // 切到试用：按后端的试用语义同步默认值（仍可手改）
                        ...(kind === 'trial'
                          ? {
                              max_purchases_per_user: f.max_purchases_per_user || '1',
                              renew_allowed: false,
                            }
                          : {}),
                      }));
                    }}
                  >
                    <option value="standard">{t('admin.kindStandard')}</option>
                    <option value="tier">{t('admin.kindTier')}</option>
                    <option value="trial">{t('admin.kindTrial')}</option>
                  </select>
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldKindHint')}
                  </span>
                </label>
                {form.kind !== 'standard' && (
                  <label className="block">
                    <span className="text-xs text-neutral-500">{t('admin.fieldParent')} *</span>
                    <select
                      className={field}
                      value={form.parent_plugin_id}
                      onChange={(e) => setForm({ ...form, parent_plugin_id: e.target.value })}
                    >
                      <option value="">{t('admin.parentPick')}</option>
                      {items
                        .filter((p) => p.kind !== 'tier' && p.kind !== 'trial' && p.id !== editingId)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}（{p.slug}）
                          </option>
                        ))}
                    </select>
                    <span className="block mt-1 text-[11px] text-neutral-400">
                      {t('admin.fieldParentHint')}
                    </span>
                  </label>
                )}
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldPurchaseLimit')}</span>
                  <input
                    className={field}
                    type="number"
                    min="1"
                    max="999"
                    placeholder="留空＝不限"
                    value={form.max_purchases_per_user}
                    onChange={(e) =>
                      setForm({ ...form, max_purchases_per_user: e.target.value })
                    }
                  />
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldPurchaseLimitHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldRenewAllowed')}</span>
                  <select
                    className={field}
                    value={form.renew_allowed ? '1' : '0'}
                    onChange={(e) =>
                      setForm({ ...form, renew_allowed: e.target.value === '1' })
                    }
                  >
                    <option value="1">{t('admin.renewYes')}</option>
                    <option value="0">{t('admin.renewNo')}</option>
                  </select>
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldRenewAllowedHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldPrice')}</span>
                  <input
                    className={field}
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="9.9"
                    value={form.priceYuan}
                    onChange={(e) => setForm({ ...form, priceYuan: e.target.value })}
                  />
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldPriceHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldListPrice')}</span>
                  <input
                    className={field}
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="39.9"
                    value={form.listPriceYuan}
                    onChange={(e) => setForm({ ...form, listPriceYuan: e.target.value })}
                  />
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldListPriceHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldPromoEndsAt')}</span>
                  <input
                    className={field}
                    type="datetime-local"
                    value={form.promoEndsAt}
                    onChange={(e) => setForm({ ...form, promoEndsAt: e.target.value })}
                  />
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldPromoEndsAtHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldOrder')}</span>
                  <input
                    className={field}
                    type="number"
                    value={form.sort_order}
                    onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldMaxActivations')}</span>
                  <input
                    className={field}
                    type="number"
                    min="1"
                    max="50"
                    value={form.max_activations}
                    onChange={(e) => setForm({ ...form, max_activations: e.target.value })}
                  />
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldMaxActivationsHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldDuration')}</span>
                  <input
                    className={field}
                    type="number"
                    min="1"
                    max="3650"
                    value={form.subscription_duration_days}
                    onChange={(e) => setForm({ ...form, subscription_duration_days: e.target.value })}
                  />
                  <span className="block mt-1 text-[11px] text-neutral-400">
                    {t('admin.fieldDurationHint')}
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldStatus')}</span>
                  <select
                    className={field}
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                  >
                    <option value="active">{t('admin.statusActive')}</option>
                    <option value="hidden">{t('admin.statusHidden')}</option>
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="text-xs text-neutral-500">{t('admin.fieldTagline')}</span>
                <input
                  className={field}
                  value={form.tagline}
                  onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                />
              </label>

              <label className="block">
                <span className="text-xs text-neutral-500">{t('admin.fieldDescription')}</span>
                <textarea
                  className={`${field} h-20 resize-y`}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>

              <label className="block">
                <span className="text-xs text-neutral-500">{t('admin.fieldFeatures')}</span>
                <textarea
                  className={`${field} h-24 resize-y`}
                  placeholder={t('admin.fieldFeaturesPlaceholder')}
                  value={form.featuresText}
                  onChange={(e) => setForm({ ...form, featuresText: e.target.value })}
                />
                <span className="block mt-1 text-[11px] text-neutral-400">
                  {t('admin.fieldFeaturesHint')}
                </span>
              </label>

              <label className="block">
                <span className="text-xs text-neutral-500">{t('admin.fieldIcon')}</span>
                <input
                  className={field}
                  value={form.icon_url}
                  onChange={(e) => setForm({ ...form, icon_url: e.target.value })}
                />
              </label>

              {/* 安装包：上传到 OSS 的 plugins/{slug}/ 目录，拿到 key 后随表单一起保存 */}
              <div className="rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-neutral-500">{t('admin.fieldPackage')}</span>
                  {!!form.download_key && (
                    <span className="text-[11px] text-green-600">{t('admin.packageUploaded')}</span>
                  )}
                </div>

                {form.download_key ? (
                  <div className="bg-neutral-50 rounded-lg px-3 py-2 mb-3 text-xs">
                    <div className="font-medium text-neutral-800 break-all">
                      {form.download_filename || '—'}
                    </div>
                    <div className="text-neutral-400 mt-0.5 break-all">{form.download_key}</div>
                  </div>
                ) : (
                  <div className="bg-amber-50 text-amber-700 rounded-lg px-3 py-2 mb-3 text-xs">
                    {t('admin.packageNone')}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <label
                    className={`px-3 py-1.5 text-xs rounded-lg border border-neutral-200 ${
                      uploading ? 'opacity-50 cursor-wait' : 'cursor-pointer hover:bg-neutral-50'
                    }`}
                  >
                    {uploading ? t('admin.uploading') : t('admin.chooseFile')}
                    <input
                      type="file"
                      accept=".zip,.crx"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        // 先清空 value，否则连续选同一个文件不会再次触发 change
                        e.target.value = '';
                        if (f) uploadPackage(f);
                      }}
                    />
                  </label>
                  <span className="text-[11px] text-neutral-400">{t('admin.fieldPackageHint')}</span>
                </div>

                {!!uploadErr && <div className="mt-2 text-xs text-red-600">{uploadErr}</div>}

                <details className="mt-3">
                  <summary className="text-[11px] text-neutral-400 cursor-pointer select-none">
                    {t('admin.packageManual')}
                  </summary>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                    <label className="block">
                      <span className="text-xs text-neutral-500">{t('admin.fieldDownloadKey')}</span>
                      <input
                        className={field}
                        placeholder="plugins/alibaba-toolkit/client.zip"
                        value={form.download_key}
                        onChange={(e) => setForm({ ...form, download_key: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-neutral-500">{t('admin.fieldDownloadFilename')}</span>
                      <input
                        className={field}
                        placeholder="外贸工具箱.zip"
                        value={form.download_filename}
                        onChange={(e) => setForm({ ...form, download_filename: e.target.value })}
                      />
                    </label>
                  </div>
                </details>
              </div>

              {err && <div className="text-xs text-red-600">{err}</div>}
            </div>

            <div className="px-5 py-4 border-t border-neutral-100 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="px-4 py-1.5 text-sm border border-neutral-200 rounded-lg hover:bg-neutral-50"
              >
                {t('admin.cancel')}
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
              >
                {t('admin.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 订阅用户弹窗：点击列表里的「订阅数」打开 */}
      {usersOpen && usersPlugin && (
        <Modal onClose={() => setUsersOpen(false)} align="top" backdrop="bg-black/40">
          <div className="bg-white rounded-xl w-full max-w-3xl my-8 shadow-xl">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
              <h2 className="font-semibold text-neutral-900">
                {usersPlugin.name} · {t('admin.usersTitle')}
                <span className="ml-2 text-sm font-normal text-neutral-500">
                  {t('admin.usersTotal', { n: usersTotal })}
                </span>
              </h2>
              <button
                onClick={() => setUsersOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="p-5 space-y-4">
              <input
                className={field}
                placeholder={t('admin.usersSearch')}
                value={usersSearch}
                onChange={(e) => setUsersSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadUsers(usersPlugin.id, 1, usersSearch);
                }}
              />

              {/* 2026-10-12 三轮质检：加载失败必须显式可见，不能伪装成「无用户」 */}
              {usersErr && (
                <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {usersErr}
                </div>
              )}

              {usersLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
                </div>
              ) : users.length === 0 ? (
                usersErr ? null : (
                  <div className="py-12 text-center text-neutral-400 text-sm">
                    {t('admin.usersEmpty')}
                  </div>
                )
              ) : (
                <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
                      <tr>
                        <th className="px-3 py-2 text-left">{t('admin.usersUuid')}</th>
                        <th className="px-3 py-2 text-left">{t('admin.usersName')}</th>
                        <th className="px-3 py-2 text-left">{t('admin.usersEmail')}</th>
                        <th className="px-3 py-2 text-left">{t('admin.usersStartDate')}</th>
                        <th className="px-3 py-2 text-left">{t('admin.usersRecentDate')}</th>
                        <th className="px-3 py-2 text-left">{t('admin.usersStatus')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {users.map((u) => (
                        <tr key={u.user_id} className="hover:bg-neutral-50">
                          <td className="px-3 py-2">
                            <code className="text-xs text-neutral-500 break-all">{u.user_id}</code>
                          </td>
                          <td className="px-3 py-2 text-neutral-800">{u.user_name || '—'}</td>
                          <td className="px-3 py-2 text-neutral-600">{u.user_email || '—'}</td>
                          <td className="px-3 py-2 text-neutral-500 tabular-nums whitespace-nowrap">
                            {u.start_date ? new Date(u.start_date).toLocaleString('zh-CN') : '—'}
                          </td>
                          <td className="px-3 py-2 text-neutral-500 tabular-nums whitespace-nowrap">
                            {u.expire_date ? new Date(u.expire_date).toLocaleString('zh-CN') : '—'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {Number(u.valid_cnt) > 0 ? (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                                {t('admin.usersStatusValid')}
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-500">
                                {t('admin.usersStatusExpired')}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
        </>
      )}
    </div>
  );
}
