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
          </div>
        </>
      )}
    </div>
  );
}
