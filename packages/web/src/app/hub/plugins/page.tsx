'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import Modal from '../../components/Modal';

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
  download_key: string | null;
  download_filename: string | null;
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
  status: string;
  download_key: string;
  download_filename: string;
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
  max_activations: '2',
  status: 'active',
  download_key: '',
  download_filename: '',
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

  const fetchData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
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
      status: p.status || 'active',
      download_key: p.download_key || '',
      download_filename: p.download_filename || '',
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
      max_activations: Math.max(1, Math.round(Number(form.max_activations) || 2)),
      status: form.status,
      download_key: form.download_key.trim() || null,
      download_filename: form.download_filename.trim() || null,
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
                <th className="px-4 py-3 text-center hidden lg:table-cell">{t('admin.thDevices')}</th>
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
                    {p.max_activations ?? 2}
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
                  <td colSpan={8} className="px-4 py-12 text-center text-neutral-400 text-sm">
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
    </div>
  );
}
