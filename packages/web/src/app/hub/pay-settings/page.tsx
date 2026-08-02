'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubPaySettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<any>(null);
  const [commission, setCommission] = useState('');
  const [prices, setPrices] = useState({ monthly: '', quarterly: '', yearly: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const token = getToken(); if (!token) return;
    fetch('/api/admin/pay/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => {
        setSettings(j);
        setCommission(String((j.commissionRateBp || 0) / 100));
        setPrices({
          monthly: String((j.membershipPrices?.monthly || 0) / 100),
          quarterly: String((j.membershipPrices?.quarterly || 0) / 100),
          yearly: String((j.membershipPrices?.yearly || 0) / 100),
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

  const savePrices = async () => {
    const token = getToken(); if (!token) return;
    setMsg('');
    const r = await fetch('/api/admin/pay/settings/membership-prices', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        monthly: Math.round(Number(prices.monthly) * 100),
        quarterly: Math.round(Number(prices.quarterly) * 100),
        yearly: Math.round(Number(prices.yearly) * 100),
      }),
    });
    setMsg(r.ok ? '会员价已保存' : '保存失败');
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

      <div className="bg-white border rounded-xl p-5 max-w-md">
        <h2 className="text-sm font-medium text-neutral-700 mb-3">Pro 会员定价（元）</h2>
        <div className="space-y-3">
          <PriceRow label={t('admin.membershipPriceMonthly')} value={prices.monthly} onChange={v => setPrices(p => ({ ...p, monthly: v }))} />
          <PriceRow label={t('admin.membershipPriceQuarterly')} value={prices.quarterly} onChange={v => setPrices(p => ({ ...p, quarterly: v }))} />
          <PriceRow label={t('admin.membershipPriceYearly')} value={prices.yearly} onChange={v => setPrices(p => ({ ...p, yearly: v }))} />
        </div>
        <button onClick={savePrices} className="mt-4 px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700">{t('admin.saveSettings')}</button>
      </div>
    </div>
  );
}

function PriceRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <input type="number" step="0.01" value={value} onChange={e => onChange(e.target.value)}
        className="px-3 py-1.5 text-sm border rounded-lg w-32" />
    </div>
  );
}
