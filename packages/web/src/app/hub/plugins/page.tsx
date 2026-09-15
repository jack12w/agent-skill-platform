'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

interface PluginItem {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  icon_url: string | null;
  category: string;
  price_monthly_cents: number;
  currency: string;
  status: string;
  sort_order: number;
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
  sort_order: string;
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
  sort_order: '0',
  status: 'active',
  download_key: '',
  download_filename: '',
};

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
      sort_order: String(p.sort_order ?? 0),
      status: p.status || 'active',
      download_key: p.download_key || '',
      download_filename: p.download_filename || '',
    });
    setErr('');
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
      sort_order: Number(form.sort_order) || 0,
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
                  <td className="px-4 py-3 text-right tabular-nums">{fmtPrice(p.price_monthly_cents)}</td>
                  <td className="px-4 py-3 text-center text-neutral-500 hidden sm:table-cell">{p.sort_order}</td>
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
                  <td colSpan={7} className="px-4 py-12 text-center text-neutral-400 text-sm">
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
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
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
                    placeholder="99"
                    value={form.priceYuan}
                    onChange={(e) => setForm({ ...form, priceYuan: e.target.value })}
                  />
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
                <span className="text-xs text-neutral-500">{t('admin.fieldIcon')}</span>
                <input
                  className={field}
                  value={form.icon_url}
                  onChange={(e) => setForm({ ...form, icon_url: e.target.value })}
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldDownloadKey')}</span>
                  <input
                    className={field}
                    placeholder="plugins/{id}/client.zip"
                    value={form.download_key}
                    onChange={(e) => setForm({ ...form, download_key: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500">{t('admin.fieldDownloadFilename')}</span>
                  <input
                    className={field}
                    placeholder="RFQ挖掘助手.zip"
                    value={form.download_filename}
                    onChange={(e) => setForm({ ...form, download_filename: e.target.value })}
                  />
                </label>
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
        </div>
      )}
    </div>
  );
}
