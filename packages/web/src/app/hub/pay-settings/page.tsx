'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubPaySettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<any>(null);
  const [commission, setCommission] = useState('');
  const [payout, setPayout] = useState({ days: '', min: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const token = getToken(); if (!token) return;
    fetch('/api/admin/pay/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => {
        setSettings(j);
        setCommission(String((j.commissionRateBp || 0) / 100));
        setPayout({
          days: String(j.settlementDelayDays ?? 7),
          min: String((j.withdrawMinCents ?? 2000) / 100),
        });
      })
      .catch(e => console.error(e));
  }, []);

  const saveCommission = async () => {
    const token = getToken(); if (!token) return;
    setMsg('');
    const bp = Math.round(Number(commission) * 100);
    const r = await fetch('/api/admin/pay/settings/commission', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ commissionRateBp: bp }),
    });
    setMsg(r.ok ? '抽成已保存' : '保存失败');
  };

  const savePayout = async () => {
    const token = getToken(); if (!token) return;
    setMsg('');
    const r = await fetch('/api/admin/pay/settings/payout', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        settlementDelayDays: Math.round(Number(payout.days)),
        withdrawMinCents: Math.round(Number(payout.min) * 100),
      }),
    });
    if (r.ok) { setMsg('结算设置已保存'); return; }
    const e = await r.json().catch(() => ({}));
    setMsg(e.message || '保存失败');
  };

  if (!settings) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.paySettings')}</h1>
      {msg && <div className="text-sm text-green-600 mb-3">{msg}</div>}

      <div className="bg-white border rounded-xl p-5 mb-5 max-w-md">
        <label className="block text-sm font-medium text-neutral-700 mb-1">{t('admin.commissionRate')}</label>
        <div className="flex items-center gap-2">
          <input type="number" step="0.1" value={commission} onChange={e => setCommission(e.target.value)}
            className="px-3 py-1.5 text-sm border rounded-lg w-32" />
          <span className="text-sm text-neutral-500">%（历史订单不受影响，仅影响新订单）</span>
        </div>
        <button onClick={saveCommission} className="mt-3 px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700">{t('admin.saveSettings')}</button>
      </div>

      <div className="bg-white border rounded-xl p-5 mb-5 max-w-md">
        <h2 className="text-sm font-medium text-neutral-700 mb-1">{t('admin.payoutSettings')}</h2>
        <p className="text-xs text-neutral-500 mb-3">{t('admin.payoutSettingsHint')}</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-600">{t('admin.settlementDelay')}</span>
            <div className="flex items-center gap-1.5">
              <input type="number" step="1" min="0" max="90" value={payout.days}
                onChange={e => setPayout(p => ({ ...p, days: e.target.value }))}
                className="px-3 py-1.5 text-sm border rounded-lg w-24" />
              <span className="text-sm text-neutral-500">{t('admin.days')}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-600">{t('admin.withdrawMin')}</span>
            <div className="flex items-center gap-1.5">
              <input type="number" step="1" min="1" value={payout.min}
                onChange={e => setPayout(p => ({ ...p, min: e.target.value }))}
                className="px-3 py-1.5 text-sm border rounded-lg w-24" />
              <span className="text-sm text-neutral-500">{t('admin.yuan')}</span>
            </div>
          </div>
        </div>
        <button onClick={savePayout} className="mt-4 px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700">{t('admin.saveSettings')}</button>
      </div>
    </div>
  );
}
