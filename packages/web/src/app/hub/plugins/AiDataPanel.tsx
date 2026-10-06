'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import useTranslation from '../../../hooks/useTranslation';

/**
 * 管理后台「插件数据」看板（AI 数据服务，方案 v2.1 §10；计划 v2.4 多类型扩展）。
 *
 * 只读面板：一个聚合接口出全部数据（GET /api/admin/plugins/ai-data/overview）。
 * 约定：管理员看板不脱敏邮箱；无明细下钻（排障走 psql）；
 * 请求必须 no-store（管理端读接口一律 no-store，防启发式缓存假象）。
 * 0028：数据集口径 = 逻辑快照数；磁盘容量卡片（statfs 整盘）；来源/类型中文映射。
 */

interface Summary {
  push_users: number;
  sub_users: number;
  datasets: number;
  records: number;
  payload_bytes: number;
  table_bytes: number;
}

interface DiskInfo {
  total: number;
  free: number;
}

interface PusherRow {
  user_id: string;
  label: string;
  datasets: number;
  records: number;
  payload_bytes: number;
  last_push_at: string | null;
  last_source: string;
  ok7: number;
  fail7: number;
}

interface ConsumerRow {
  user_id: string;
  label: string;
  keys_active: number;
  queries_total: number;
  ok_total: number;
  ok7: number;
  fail7: number;
  last_query_at: string | null;
  top_type: string;
}

interface StorageRow {
  type: string;
  vendor_slug: string;
  datasets: number;
  records: number;
  bytes: number;
}

interface SourceRow {
  source: string;
  datasets: number;
  bytes: number;
}

interface Overview {
  summary: Summary;
  disk: DiskInfo | null;
  typeLabels: Record<string, string>;
  pushers: PusherRow[];
  consumers: ConsumerRow[];
  storageByType: StorageRow[];
  sourceSummary: SourceRow[];
}

/** 来源列中文映射（ai_dataset.source：auto=每日定时自动采集 / manual=手动点按钮） */
const SOURCE_LABEL: Record<string, string> = {
  auto: '自动采集',
  manual: '手动采集',
  unknown: '未知',
  '': '未知',
};

function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] || s || '未知';
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

/** ISO → MM-DD HH:mm（本地时区） */
function fmtTime(isoStr: string | null): string {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const th = 'px-3 py-2 text-left font-normal text-neutral-500 whitespace-nowrap';
const td = 'px-3 py-2 whitespace-nowrap';

export default function AiDataPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/plugins/ai-data/overview', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch {
      // 失败不清空旧数据：保留上次快照 + 报错（防一次网络抖动清空整页）
      setErr(t('admin.aiLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const s = data?.summary;
  const maxBytes = Math.max(1, ...(data?.storageByType ?? []).map((r) => r.bytes));
  const typeLabel = (ty: string): string => data?.typeLabels?.[ty] || ty;
  const disk = data?.disk;
  const diskUsed = disk ? disk.total - disk.free : 0;
  const diskLow = disk ? disk.free / Math.max(1, disk.total) < 0.1 : false;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-sm border border-neutral-200 rounded-lg hover:bg-neutral-50 disabled:opacity-50"
        >
          {loading ? '…' : '↻'} {t('admin.loading')}
        </button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>

      {/* 指标卡 ×4 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <MetricCard label={t('admin.aiPushUsers')} value={s ? `${fmtInt(s.push_users)} / ${fmtInt(s.sub_users)}` : '—'} />
        <MetricCard label={t('admin.aiDatasets')} value={s ? fmtInt(s.datasets) : '—'} />
        <MetricCard label={t('admin.aiRecords')} value={s ? fmtInt(s.records) : '—'} />
        <MetricCard
          label={t('admin.aiPayloadBytes')}
          value={s ? fmtBytes(s.payload_bytes) : '—'}
          sub={
            disk
              ? `${t('admin.aiTableBytes')} ${fmtBytes(s?.table_bytes ?? 0)} ｜ ${t('admin.aiDiskUsed')} ${fmtBytes(diskUsed)} / ${fmtBytes(disk.total)} · ${t('admin.aiDiskFree')} ${fmtBytes(disk.free)}`
              : s
                ? `${t('admin.aiTableBytes')} ${fmtBytes(s.table_bytes)}`
                : undefined
          }
          tone={diskLow ? 'danger' : undefined}
        />
      </div>

      {/* 推送用户表 */}
      <SectionTitle>{t('admin.aiPushersTitle')}</SectionTitle>
      <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto mb-5">
        {data && data.pushers.length === 0 ? (
          <EmptyRow text={t('admin.aiEmpty')} />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 text-xs uppercase text-neutral-500">
              <tr>
                <th className={th}>{t('admin.aiThUser')}</th>
                <th className={th}>{t('admin.aiThDatasets')}</th>
                <th className={th}>{t('admin.aiThRecords')}</th>
                <th className={th}>{t('admin.aiThBytes')}</th>
                <th className={th}>{t('admin.aiThLastPush')}</th>
                <th className={th}>{t('admin.aiThSource')}</th>
                <th className={th}>{t('admin.aiTh7d')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(data?.pushers ?? []).map((r) => (
                <tr key={r.user_id} className="hover:bg-neutral-50">
                  <td className={`${td} font-medium text-neutral-900`}>{r.label}</td>
                  <td className={td}>{fmtInt(r.datasets)}</td>
                  <td className={td}>{fmtInt(r.records)}</td>
                  <td className={td}>{fmtBytes(r.payload_bytes)}</td>
                  <td className={td}>{fmtTime(r.last_push_at)}</td>
                  <td className={td}>{sourceLabel(r.last_source)}</td>
                  <td className={td}>
                    <span className="text-green-700">{r.ok7} ok</span>
                    {r.fail7 > 0 && <span className="text-red-600"> · {r.fail7} fail</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 使用用户表 */}
      <SectionTitle>{t('admin.aiConsumersTitle')}</SectionTitle>
      <div className="bg-white border border-neutral-200 rounded-xl overflow-x-auto mb-5">
        {data && data.consumers.length === 0 ? (
          <EmptyRow text={t('admin.aiEmpty')} />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 text-xs uppercase text-neutral-500">
              <tr>
                <th className={th}>{t('admin.aiThUser')}</th>
                <th className={th}>{t('admin.aiThKeys')}</th>
                <th className={th}>{t('admin.aiThQueries')}</th>
                <th className={th}>{t('admin.aiTh7d')}</th>
                <th className={th}>{t('admin.aiThLastQuery')}</th>
                <th className={th}>{t('admin.aiThTopType')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(data?.consumers ?? []).map((r) => (
                <tr key={r.user_id} className="hover:bg-neutral-50">
                  <td className={`${td} font-medium text-neutral-900`}>{r.label}</td>
                  <td className={td}>{fmtInt(r.keys_active)}</td>
                  <td className={td}>
                    {fmtInt(r.queries_total)}
                    {r.ok_total < r.queries_total && (
                      <span className="text-red-600"> ({fmtInt(r.queries_total - r.ok_total)} fail)</span>
                    )}
                  </td>
                  <td className={td}>
                    <span className="text-green-700">{r.ok7} ok</span>
                    {r.fail7 > 0 && <span className="text-red-600"> · {r.fail7} fail</span>}
                  </td>
                  <td className={td}>{fmtTime(r.last_query_at)}</td>
                  <td className={td}>{r.top_type ? typeLabel(r.top_type) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 存储构成 + 来源分布 */}
      <SectionTitle>{t('admin.aiStorageTitle')}</SectionTitle>
      <div className="bg-white border border-neutral-200 rounded-xl p-4 mb-2">
        {data && data.storageByType.length === 0 ? (
          <EmptyRow text={t('admin.aiEmpty')} />
        ) : (
          <>
            {(data?.storageByType ?? []).map((r) => (
              <div key={`${r.type}-${r.vendor_slug}`} className="flex items-center gap-3 mb-2 last:mb-0">
                <span className="text-sm text-neutral-700 w-36 shrink-0">
                  {typeLabel(r.type)}
                  <span className="ml-1 text-[11px] text-neutral-400">{r.vendor_slug}</span>
                </span>
                <div className="flex-1 h-3.5 bg-neutral-100 rounded overflow-hidden">
                  <div
                    className="h-full bg-brand-600 rounded"
                    style={{ width: `${Math.max(2, Math.round((r.bytes / maxBytes) * 100))}%` }}
                  />
                </div>
                <span className="text-xs text-neutral-500 w-44 text-right shrink-0">
                  {fmtBytes(r.bytes)} · {fmtInt(r.datasets)} {t('admin.aiThDatasets')} · {fmtInt(r.records)} {t('admin.aiThRecords')}
                </span>
              </div>
            ))}
            {data && data.sourceSummary.length > 0 && (
              <p className="text-xs text-neutral-500 mt-3 pt-3 border-t border-neutral-100">
                {t('admin.aiSourceSummary')}：
                {data.sourceSummary
                  .map((r) => `${sourceLabel(r.source)} ${fmtInt(r.datasets)} ${t('admin.aiThDatasets')} / ${fmtBytes(r.bytes)}`)
                  .join(' · ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'danger';
}) {
  return (
    <div className={`rounded-lg p-4 ${tone === 'danger' ? 'bg-red-50' : 'bg-neutral-50'}`}>
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className="text-2xl font-medium text-neutral-900">{value}</p>
      {sub && (
        <p className={`text-xs mt-1 ${tone === 'danger' ? 'text-red-600' : 'text-neutral-400'}`}>{sub}</p>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium text-neutral-800 mb-2">{children}</h3>;
}

function EmptyRow({ text }: { text: string }) {
  return <p className="text-sm text-neutral-400 text-center py-10">{text}</p>;
}
