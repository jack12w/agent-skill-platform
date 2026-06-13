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
    { label: 'Site Name', value: cfg.siteName },
    { label: 'Version', value: cfg.version },
    { label: 'Environment', value: cfg.nodeEnv },
    { label: 'Public URL', value: cfg.publicBaseUrl },
    { label: 'SMTP User', value: cfg.smtpUser },
    { label: 'WeChat OAuth', value: cfg.wechatEnabled ? 'Enabled' : 'Disabled' },
    { label: 'WeChat Login', value: cfg.wechatLoginEnabled ? 'Enabled' : 'Disabled' },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-4">{t('admin.settings')}</h1>
      <div className="bg-white border rounded-xl divide-y divide-gray-100">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-gray-600">{r.label}</span>
            <span className="text-sm font-medium text-gray-900">{String(r.value)}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-gray-400">Settings are managed via .env.production file on the server.</p>
    </div>
  );
}
