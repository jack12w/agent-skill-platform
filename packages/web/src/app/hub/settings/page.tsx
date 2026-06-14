'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubSettingsPage() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<any>(null);

  useEffect(() => {
    const token = getToken(); if (!token) return;
    fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setCfg);
  }, []);

  if (!cfg) return null;

  const rows = [
    { label: t('admin.thSiteName'), value: cfg.siteName },
    { label: t('admin.thVersion'), value: cfg.version },
    { label: t('admin.thEnvironment'), value: cfg.nodeEnv },
    { label: t('admin.thPublicUrl'), value: cfg.publicBaseUrl },
    { label: t('admin.thSmtpUser'), value: cfg.smtpUser },
    { label: t('admin.thWechatOauth'), value: cfg.wechatEnabled ? 'Enabled' : 'Disabled' },
    { label: t('admin.thWechatLogin'), value: cfg.wechatLoginEnabled ? 'Enabled' : 'Disabled' },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.settings')}</h1>
      <div className="bg-white border rounded-xl divide-y divide-neutral-100">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-neutral-600">{r.label}</span>
            <span className="text-sm font-medium text-neutral-900">{String(r.value)}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-neutral-400">{t('admin.logTableHint')}</p>
    </div>
  );
}
