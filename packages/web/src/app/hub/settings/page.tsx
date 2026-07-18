'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

/** 极简 SVG 折线图（无依赖） */
function Sparkline({ data, color = '#2563eb' }: { data: number[]; color?: string }) {
  if (!data || data.length < 2) {
    return <span className="text-xs text-neutral-400">—</span>;
  }
  const w = 260;
  const h = 44;
  const max = Math.max(...data, 1);
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`)
    .join(' ');
  const last = data[data.length - 1];
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      <text x={w} y={h - 4} textAnchor="end" fontSize="10" fill="#9ca3af">
        {last}
      </text>
    </svg>
  );
}

export default function HubSettingsPage() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    fetch('/api/admin/settings', { headers: h })
      .then(r => r.json()).then(setCfg);
    fetch('/api/admin/system-metrics', { headers: h })
      .then(r => r.json()).then(setMetrics).catch(() => setMetrics(null));
  }, []);

  if (!cfg) return null;

  const settingRows = [
    { label: t('admin.thSiteName'), value: cfg.siteName },
    { label: t('admin.thVersion'), value: cfg.version },
    { label: t('admin.thEnvironment'), value: cfg.nodeEnv },
    { label: t('admin.thPublicUrl'), value: cfg.publicBaseUrl },
    { label: t('admin.thSmtpUser'), value: cfg.smtpUser },
    { label: t('admin.thWechatOauth'), value: cfg.wechatEnabled ? 'Enabled' : 'Disabled' },
    { label: t('admin.thWechatLogin'), value: cfg.wechatLoginEnabled ? 'Enabled' : 'Disabled' },
  ];

  const metricRows = metrics
    ? [
        { label: t('admin.metricsUptime'), value: fmtUptime(metrics.process.uptime) },
        { label: t('admin.metricsMemory'), value: `${metrics.process.memoryRssMb} MB` },
        { label: t('admin.metricsLoad'), value: `${metrics.system.loadavg1} / ${metrics.system.cpuCores} cores` },
        { label: t('admin.metricsReqPerMin'), value: metrics.requests.perMinute },
        { label: t('admin.metricsReqPerSec'), value: metrics.requests.perSecond },
        { label: t('admin.metricsDbConns'), value: metrics.database.activeConnections ?? '—' },
        {
          label: t('admin.metricsQueue'),
          value: metrics.mailQueue
            ? `等待 ${metrics.mailQueue.waiting ?? 0} / 处理中 ${metrics.mailQueue.active ?? 0} / 失败 ${metrics.mailQueue.failed ?? 0}`
            : '内联（无队列）',
        },
      ]
    : [];

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.settings')}</h1>
      <div className="bg-white border rounded-xl divide-y divide-neutral-100">
        {settingRows.map(r => (
          <div key={r.label} className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-neutral-600">{r.label}</span>
            <span className="text-sm font-medium text-neutral-900">{String(r.value)}</span>
          </div>
        ))}
      </div>

      {metrics && (
        <>
          <h2 className="text-lg font-bold text-neutral-900 mt-8 mb-4">{t('admin.metricsTitle')}</h2>
          <div className="bg-white border rounded-xl divide-y divide-neutral-100">
            {metricRows.map(r => (
              <div key={r.label} className="flex items-center justify-between px-5 py-3">
                <span className="text-sm text-neutral-600">{r.label}</span>
                <span className="text-sm font-medium text-neutral-900">{String(r.value)}</span>
              </div>
            ))}

            {metrics.requests?.history ? (
              <div className="px-5 py-4">
                <div className="text-sm text-neutral-600 mb-2">{t('admin.metricsRealtime')}</div>
                <Sparkline data={metrics.requests.history.map((h: any) => h.count)} />
              </div>
            ) : null}

            {metrics.requests?.dailyHistory ? (
              <div className="px-5 py-4">
                <div className="text-sm text-neutral-600 mb-2">{t('admin.metrics7d')}</div>
                <Sparkline
                  data={metrics.requests.dailyHistory.map((d: any) => d.count)}
                  color="#16a34a"
                />
              </div>
            ) : (
              <div className="px-5 py-4 text-xs text-neutral-400">{t('admin.metricsNoRedis')}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
