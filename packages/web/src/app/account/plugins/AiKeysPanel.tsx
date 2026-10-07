'use client';

import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

/**
 * AI 数据取数密钥面板（T302）—— account/plugins 页「密钥管理」子 TAB。
 *
 * 数据源：/api/ai/keys（用户 JWT；GET 列表 / POST 生成 / DELETE 吊销）。
 * 请求一律 no-store（账户页 9-27 HTTP 缓存事故纪律：读回类接口禁走缓存）。
 * 明文密钥只在创建响应出现一次，前端用 state 临时展示 + 复制按钮，绝不存 localStorage。
 */
interface KeyRow {
  id: number;
  label: string;
  keyMasked: string;
  createdAt: string;
  revokedAt: string | null;
}

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
function currentUserId(): string | null {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')?.id || null;
  } catch {
    return null;
  }
}

export default function AiKeysPanel({
  onNotice,
}: {
  onNotice?: (s: string | null) => void;
}) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [copied, setCopied] = useState(false);
  /* 一键使用卡片（2026-10-06）：WorkBuddy 粘贴 JSON / ACCIO WORK HTTP 表单三行，两平台同端点 */
  const [useTab, setUseTab] = useState<'wb' | 'accio'>('wb');
  const [useCopied, setUseCopied] = useState(false);
  /* ACCIO 三行独立复制的「已复制」标记（2026-10-07） */
  const [copiedField, setCopiedField] = useState('');

  const load = useCallback(async () => {
    if (!currentUserId()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/ai/keys', {
        headers: authHeaders(),
        cache: 'no-store',
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        setKeys(Array.isArray(j.keys) ? j.keys : []);
        onNotice?.(null);
      } else {
        onNotice?.(`${t('plugins.keysLoadFailed')} (${res.status})`);
      }
    } catch {
      onNotice?.(t('plugins.keysLoadFailed'));
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setCopied(false);
    try {
      const res = await fetch('/api/ai/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        cache: 'no-store',
        body: JSON.stringify({ label: label.trim().slice(0, 64) }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok && j.key) {
        setNewKey(String(j.key));
        setLabel('');
        await load();
      } else {
        /* 后端业务文案优先（如 KEY_LIMIT：有效密钥最多 10 个…），别吞成统一「操作失败」 */
        onNotice?.(String(j?.error || j?.message || t('plugins.keysCreateFailed')));
      }
    } catch {
      onNotice?.(t('plugins.keysCreateFailed'));
    }
    setCreating(false);
  };

  const revoke = async (row: KeyRow) => {
    if (busyId) return;
    if (!confirm(t('plugins.keysRevokeConfirm'))) return;
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/ai/keys/${row.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
        cache: 'no-store',
      });
      if (res.ok) onNotice?.(t('plugins.keysRevokeDone'));
      else onNotice?.(t('plugins.keysCreateFailed'));
      await load();
    } catch {
      onNotice?.(t('plugins.keysCreateFailed'));
    }
    setBusyId(null);
  };

  const delKey = async (row: KeyRow) => {
    if (busyId) return;
    if (!confirm(t('plugins.keysDelConfirm'))) return;
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/ai/keys/${row.id}?purge=1`, {
        method: 'DELETE',
        headers: authHeaders(),
        cache: 'no-store',
      });
      if (res.ok) onNotice?.(t('plugins.keysDelDone'));
      else onNotice?.(t('plugins.keysCreateFailed'));
      await load();
    } catch {
      onNotice?.(t('plugins.keysCreateFailed'));
    }
    setBusyId(null);
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      /* 剪贴板权限被拒：用户可手动选中文本复制 */
    }
  };

  /* MCP 端点（origin 运行时取，避免硬编码域名）；WorkBuddy JSON 与 ACCIO 三行共用 */
  const mcpBase = `${typeof window !== 'undefined' ? window.location.origin : 'https://skills.rehomi.com'}/api/ai/mcp`;

  /* 一键使用：WorkBuddy 标签页的 JSON 配置文本（密钥自动嵌入） */
  const buildUseText = () =>
    JSON.stringify(
      {
        mcpServers: {
          外贸工具箱: {
            type: 'http',
            url: mcpBase,
            headers: { Authorization: `Bearer ${newKey}` },
          },
        },
      },
      null,
      2,
    );

  /* ACCIO HTTP 表单三行（2026-10-07 真机核实 ACCIO 支持自定义请求头，Key=Value 格式）：
     字段名与 ACCIO 配置页同名，一行对一个输入框独立复制。鉴权走 header，密钥不进 URL。 */
  const accioFields = [
    { id: 'name', label: t('plugins.keysAccioName'), value: '外贸工具箱' },
    { id: 'url', label: t('plugins.keysAccioUrl'), value: mcpBase },
    { id: 'header', label: t('plugins.keysAccioHeader'), value: `Authorization=Bearer ${newKey}` },
  ];

  const copyField = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(id);
      setTimeout(() => setCopiedField(''), 1500);
    } catch {
      /* 剪贴板权限被拒：值可手动选中复制（code 块带 select-all） */
    }
  };

  const copyUseText = async () => {
    try {
      await navigator.clipboard.writeText(buildUseText());
      setUseCopied(true);
    } catch {
      /* 剪贴板权限被拒：用户可手动选中文本复制 */
    }
  };

  if (!currentUserId()) {
    return <div className="py-10 text-center text-sm text-neutral-400">{t('plugins.needLogin')}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4">
        <div className="text-sm font-semibold text-neutral-900">{t('plugins.keysTitle')}</div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">{t('plugins.keysHint')}</p>
        <p className="mt-1 text-[11px] text-neutral-400">{t('plugins.keysRate')}</p>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={64}
            placeholder={t('plugins.keysLabelPh')}
            className="flex-1 max-w-xs text-sm border border-neutral-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-brand-500"
          />
          <button
            onClick={create}
            disabled={creating}
            className="text-xs text-white bg-brand-600 rounded-lg px-3 py-1.5 hover:bg-brand-700 disabled:opacity-50"
          >
            {creating ? '…' : t('plugins.keysCreate')}
          </button>
        </div>
      </div>

      {newKey && (
        <div className="rounded-xl bg-amber-50 border border-amber-300 p-4">
          <div className="text-xs font-semibold text-amber-800">{t('plugins.keysShowOnce')}</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-white border border-amber-200 rounded-lg px-3 py-2 break-all select-all">
              {newKey}
            </code>
            <button
              onClick={copyKey}
              className="shrink-0 text-xs text-brand-600 border border-brand-200 rounded-lg px-2.5 py-1.5 hover:bg-brand-50"
            >
              {copied ? t('plugins.keysCopied') : t('plugins.keysCopy')}
            </button>
          </div>
        </div>
      )}

      {newKey && (
        <div className="rounded-xl bg-brand-50 border border-brand-200 p-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-semibold text-neutral-900">{t('plugins.keysUseTitle')}</div>
            <div className="flex rounded-lg border border-neutral-200 bg-white overflow-hidden text-xs">
              <button
                onClick={() => { setUseTab('wb'); setUseCopied(false); }}
                className={`px-3 py-1.5 ${useTab === 'wb' ? 'bg-brand-600 text-white' : 'text-neutral-600 hover:bg-neutral-50'}`}
              >
                {t('plugins.keysUseWb')}
              </button>
              <button
                onClick={() => { setUseTab('accio'); setUseCopied(false); }}
                className={`px-3 py-1.5 ${useTab === 'accio' ? 'bg-brand-600 text-white' : 'text-neutral-600 hover:bg-neutral-50'}`}
              >
                {t('plugins.keysUseAccio')}
              </button>
            </div>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">{t('plugins.keysUseHint')}</p>
          <ol className="mt-2 space-y-0.5 text-xs text-neutral-600 list-decimal list-inside">
            <li>{t(useTab === 'wb' ? 'plugins.keysUseWbStep1' : 'plugins.keysUseAccioStep1')}</li>
            <li>{t(useTab === 'wb' ? 'plugins.keysUseWbStep2' : 'plugins.keysUseAccioStep2')}</li>
            <li>{t(useTab === 'wb' ? 'plugins.keysUseWbStep3' : 'plugins.keysUseAccioStep3')}</li>
          </ol>
          {useTab === 'accio' ? (
            /* ACCIO：三行独立复制（字段名与 ACCIO HTTP 配置页同名） */
            <div className="mt-2 space-y-2">
              {accioFields.map((f) => (
                <div key={f.id} className="flex items-center gap-2">
                  <span className="shrink-0 w-[76px] text-xs text-neutral-600">{f.label}</span>
                  <code className="flex-1 text-[11px] font-mono bg-white border border-neutral-200 rounded-lg px-3 py-2 break-all select-all">
                    {f.value}
                  </code>
                  <button
                    onClick={() => copyField(f.id, f.value)}
                    className={`shrink-0 text-xs border rounded-lg px-2.5 py-1.5 ${
                      copiedField === f.id
                        ? 'text-emerald-600 border-emerald-200 bg-emerald-50'
                        : 'text-brand-600 border-brand-200 hover:bg-brand-50'
                    }`}
                  >
                    {copiedField === f.id ? t('plugins.keysUseCopied') : t('plugins.keysCopy')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 text-[11px] font-mono bg-white border border-neutral-200 rounded-lg px-3 py-2 break-all select-all max-h-32 overflow-auto whitespace-pre">
                {buildUseText()}
              </code>
              <button
                onClick={copyUseText}
                className="shrink-0 text-xs text-white bg-brand-600 rounded-lg px-3 py-1.5 hover:bg-brand-700"
              >
                {useCopied ? t('plugins.keysUseCopied') : t('plugins.keysUseCopy')}
              </button>
            </div>
          )}
          <p className="mt-2 text-[11px] text-neutral-400">{t('plugins.keysUseLost')}</p>
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-sm text-neutral-400">{t('plugins.loading')}</div>
      ) : keys.length === 0 ? (
        <div className="py-10 text-center text-sm text-neutral-400">{t('plugins.keysNoKeys')}</div>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className="bg-white border border-neutral-200 rounded-xl p-4 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-neutral-900 flex items-center gap-2">
                  <code className="font-mono text-xs">{k.keyMasked}</code>
                  {k.revokedAt && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-500 border border-neutral-200">
                      {t('plugins.keysRevokedTag')}
                    </span>
                  )}
                </div>
                <div className="text-xs text-neutral-400 mt-0.5 truncate">
                  {k.label || '—'} · {new Date(k.createdAt).toLocaleDateString('zh-CN')}
                </div>
              </div>
              {k.revokedAt ? (
                /* 已吊销：可从列表删除（后端 purge=1 仅删本人已吊销行） */
                <button
                  onClick={() => delKey(k)}
                  disabled={busyId === k.id}
                  className="shrink-0 text-xs text-neutral-600 border border-neutral-200 rounded-md px-2.5 py-1 hover:bg-neutral-50 disabled:opacity-50"
                >
                  {busyId === k.id ? '…' : t('plugins.keysDel')}
                </button>
              ) : (
                <button
                  onClick={() => revoke(k)}
                  disabled={busyId === k.id}
                  className="shrink-0 text-xs text-red-600 border border-red-200 rounded-md px-2.5 py-1 hover:bg-red-50 disabled:opacity-50"
                >
                  {busyId === k.id ? '…' : t('plugins.keysRevoke')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
