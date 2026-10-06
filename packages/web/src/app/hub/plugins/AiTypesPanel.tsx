'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

/**
 * 管理后台「插件数据 → 类型注册表」子 TAB（计划 v2.4，0028）。
 *
 * type 白名单的唯一维护入口：新增 / 改中文名 / 停用启用 / 删除（有数据 409 拒）。
 * 未注册 type 的推送会被 push 接口 400 拒绝；enabled=false 只拦新推送，历史数据仍可查。
 * 写操作留痕 admin_logs（服务端）；本面板读请求 no-store（管理端纪律）。
 */

interface TypeRow {
  type: string;
  label: string;
  strict: boolean;
  enabled: boolean;
  created_at: string | null;
  datasets: number;
  records: number;
  bytes: number;
}

function getToken() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

function fmtInt(n: number): string {
  return n.toLocaleString('zh-CN');
}

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const th = 'px-3 py-2 text-left font-normal text-neutral-500 whitespace-nowrap';
const td = 'px-3 py-2 whitespace-nowrap';

export default function AiTypesPanel() {
  const { t } = useTranslation();
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [newType, setNewType] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/plugins/ai-data/types', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setTypes(Array.isArray(data?.types) ? data.types : []);
    } catch {
      setErr(t('admin.aiLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  /** 后端 HttpException body 的 error 字段优先（可读原因），退回 HTTP 状态码 */
  const errText = async (res: Response): Promise<string> => {
    const body = await res.json().catch(() => null);
    return String(body?.error || body?.message || res.status);
  };

  const add = async () => {
    const ty = newType.trim();
    if (!ty) return;
    const token = getToken();
    if (!token) return;
    setBusy('add');
    setErr('');
    try {
      const res = await fetch('/api/admin/plugins/ai-data/types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: ty, label: newLabel.trim() }),
      });
      if (!res.ok) throw new Error(await errText(res));
      setNewType('');
      setNewLabel('');
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const rename = async (row: TypeRow) => {
    const next = window.prompt(t('admin.aiTypeRenamePrompt'), row.label);
    if (next === null || next.trim() === row.label) return;
    const token = getToken();
    if (!token) return;
    setBusy(row.type);
    setErr('');
    try {
      const res = await fetch(`/api/admin/plugins/ai-data/types/${encodeURIComponent(row.type)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: next.trim() }),
      });
      if (!res.ok) throw new Error(await errText(res));
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const toggleEnabled = async (row: TypeRow) => {
    const token = getToken();
    if (!token) return;
    setBusy(row.type);
    setErr('');
    try {
      const res = await fetch(`/api/admin/plugins/ai-data/types/${encodeURIComponent(row.type)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      if (!res.ok) throw new Error(await errText(res));
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const remove = async (row: TypeRow) => {
    if (row.records > 0 || row.datasets > 0) {
      // 前端预判（后端 409 兜底）：有数据的类型只能停用
      setErr(t('admin.aiTypeDeleteHasData'));
      return;
    }
    if (!window.confirm(t('admin.aiTypeDeleteConfirm').replace('{type}', row.type))) return;
    const token = getToken();
    if (!token) return;
    setBusy(row.type);
    setErr('');
    try {
      const res = await fetch(`/api/admin/plugins/ai-data/types/${encodeURIComponent(row.type)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await errText(res));
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const field =
    'px-2.5 py-1.5 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:border-brand-400';

  return (
    <div>
      {/* 新增一行 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          className={`${field} w-48`}
          placeholder={t('admin.aiTypeNewType')}
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
        />
        <input
          className={`${field} w-48`}
          placeholder={t('admin.aiTypeNewLabel')}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          onClick={add}
          disabled={busy === 'add' || !newType.trim()}
          className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          + {t('admin.aiTypeAdd')}
        </button>
        <span className="text-[11px] text-neutral-400">{t('admin.aiTypeFormatHint')}</span>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto px-3 py-1.5 text-sm border border-neutral-200 rounded-lg hover:bg-neutral-50 disabled:opacity-50"
        >
          {loading ? '…' : '↻'} {t('admin.loading')}
        </button>
      </div>
      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

      <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto">
        {loading && types.length === 0 ? (
          <p className="text-sm text-neutral-400 text-center py-10">…</p>
        ) : types.length === 0 ? (
          <p className="text-sm text-neutral-400 text-center py-10">{t('admin.aiEmpty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 text-xs uppercase text-neutral-500">
              <tr>
                <th className={th}>{t('admin.aiTypeColType')}</th>
                <th className={th}>{t('admin.aiTypeColLabel')}</th>
                <th className={th}>{t('admin.aiTypeColStrict')}</th>
                <th className={th}>{t('admin.aiTypeColStatus')}</th>
                <th className={th}>{t('admin.aiThDatasets')}</th>
                <th className={th}>{t('admin.aiThRecords')}</th>
                <th className={th}>{t('admin.aiThBytes')}</th>
                <th className={`${th} text-right`}>{t('admin.thActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {types.map((r) => (
                <tr key={r.type} className="hover:bg-neutral-50">
                  <td className={`${td} font-medium text-neutral-900`}>
                    <code className="text-xs">{r.type}</code>
                  </td>
                  <td className={td}>{r.label || '—'}</td>
                  <td className={td}>
                    {r.strict ? (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700">
                        {t('admin.aiTypeStrict')}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-neutral-100 text-neutral-500">
                        {t('admin.aiTypeLenient')}
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        r.enabled ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {r.enabled ? t('admin.aiTypeEnabled') : t('admin.aiTypeDisabled')}
                    </span>
                  </td>
                  <td className={td}>{fmtInt(r.datasets)}</td>
                  <td className={td}>{fmtInt(r.records)}</td>
                  <td className={td}>{fmtBytes(r.bytes)}</td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <button
                      onClick={() => rename(r)}
                      disabled={busy === r.type}
                      className="text-xs text-brand-600 hover:underline disabled:opacity-40"
                    >
                      {t('admin.aiTypeRename')}
                    </button>
                    <button
                      onClick={() => toggleEnabled(r)}
                      disabled={busy === r.type}
                      className="ml-3 text-xs text-amber-600 hover:underline disabled:opacity-40"
                    >
                      {r.enabled ? t('admin.aiTypeDisable') : t('admin.aiTypeEnable')}
                    </button>
                    <button
                      onClick={() => remove(r)}
                      disabled={busy === r.type}
                      className="ml-3 text-xs text-red-600 hover:underline disabled:opacity-40"
                    >
                      {t('admin.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[11px] text-neutral-400 mt-2">{t('admin.aiTypeHint')}</p>
    </div>
  );
}
