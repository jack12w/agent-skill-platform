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
  /* 一键使用卡片（2026-10-06）：WorkBuddy 粘贴 JSON / ACCIO WORK HTTP URL，两平台同端点 */
  const [useTab, setUseTab] = useState<'wb' | 'accio'>('wb');
  const [useCopied, setUseCopied] = useState(false);

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
        onNotice?.(t('plugins.keysCreateFailed'));
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

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      /* 剪贴板权限被拒：用户可手动选中文本复制 */
    }
  };

  /* 一键使用：按当前 tab 组装配置文本（密钥自动嵌入；origin 运行时取，避免硬编码域名） */
  const buildUseText = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://skills.rehomi.com';
    const base = `${origin}/api/ai/mcp`;
    if (useTab === 'wb') {
      return JSON.stringify(
        {
          mcpServers: {
            外贸工具箱: {
              type: 'http',
              url: base,
              headers: { Authorization: `Bearer ${newKey}` },
            },
          },
        },
        null,
        2,
      );
    }
    return `${base}?key=${newKey}`;
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
          <p className="mt-2 text-[11px] text-neutral-400">
            {t('plugins.keysUseTry')}
            {useTab === 'accio' ? ' ' + t('plugins.keysUseAccioJson') : ''}
          </p>
          <p className="mt-1 text-[11px] text-neutral-400">{t('plugins.keysUseLost')}</p>
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
              {!k.revokedAt && (
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
