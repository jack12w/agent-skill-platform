'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }
function getUserId() { try { return JSON.parse(localStorage.getItem('user') || 'null')?.id || null; } catch { return null; } }

export default function HubPaySettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<any>(null);
  const [commission, setCommission] = useState('');
  const [payout, setPayout] = useState({ days: '', min: '' });
  const [msg, setMsg] = useState('');
  // ── 我的（个人创作者）会员定价 ──
  const [myPlan, setMyPlan] = useState({ monthly: '', quarterly: '', yearly: '' });
  const [planLoading, setPlanLoading] = useState(true);
  const [savingPlan, setSavingPlan] = useState(false);
  // 后端 suggested（分）→ 元，与 platform_settings/migration 种子一致
  const [suggested, setSuggested] = useState({ monthly: 29, quarterly: 79, yearly: 268 });

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
    // 载入个人会员定价（需带 Authorization，否则后端拿不到 uid 做鉴权）
    const me = getUserId();
    if (me) {
      fetch(`/api/pay/membership/plan?targetType=user&targetId=${encodeURIComponent(me)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : null)
        .then(p => {
          if (p?.suggested) {
            setSuggested({
              monthly: Math.round(p.suggested.monthly / 100),
              quarterly: Math.round(p.suggested.quarterly / 100),
              yearly: Math.round(p.suggested.yearly / 100),
            });
          }
          if (p?.hasPlan && p.plans) {
            setMyPlan({
              monthly: String((p.plans.monthly || 0) / 100),
              quarterly: String((p.plans.quarterly || 0) / 100),
              yearly: String((p.plans.yearly || 0) / 100),
            });
          } else {
            // 未设置时默认填入后端推荐价，用户可修改后再保存
            setMyPlan({
              monthly: String(suggestedRef(p).monthly),
              quarterly: String(suggestedRef(p).quarterly),
              yearly: String(suggestedRef(p).yearly),
            });
          }
        })
        .catch(() => {})
        .finally(() => setPlanLoading(false));
    } else {
      setPlanLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 从接口返回提取 suggested（元），避免闭包陷阱
  const suggestedRef = (p: any) => p?.suggested
    ? {
        monthly: Math.round(p.suggested.monthly / 100),
        quarterly: Math.round(p.suggested.quarterly / 100),
        yearly: Math.round(p.suggested.yearly / 100),
      }
    : suggested;

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

  const saveMyPlan = async () => {
    const token = getToken(); const me = getUserId(); if (!token || !me) return;
    setSavingPlan(true); setMsg('');
    const r = await fetch('/api/pay/membership/plan', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        targetType: 'user',
        targetId: me,
        monthly_cents: Math.round(Number(myPlan.monthly || 0) * 100),
        quarterly_cents: Math.round(Number(myPlan.quarterly || 0) * 100),
        yearly_cents: Math.round(Number(myPlan.yearly || 0) * 100),
      }),
    });
    setSavingPlan(false);
    setMsg(r.ok ? t('paySet.myPlanSaved') : '保存失败');
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

      <div className="bg-white border rounded-xl p-5 max-w-md">
        <h2 className="text-sm font-medium text-neutral-700 mb-1">{t('paySet.myMembershipTitle')}</h2>
        <p className="text-xs text-neutral-500 mb-2">{t('paySet.myMembershipHint')}</p>
        <p className="text-xs text-brand-600 mb-3">{t('paySet.priceRecommended')}</p>
        {planLoading ? (
          <div className="text-sm text-neutral-400">加载中…</div>
        ) : (
          <>
            <div className="space-y-3">
              <PriceRow label={t('admin.membershipPriceMonthly')} value={myPlan.monthly} placeholder={`推荐 ¥${suggested.monthly}`} onChange={v => setMyPlan(p => ({ ...p, monthly: v }))} />
              <PriceRow label={t('admin.membershipPriceQuarterly')} value={myPlan.quarterly} placeholder={`推荐 ¥${suggested.quarterly}`} onChange={v => setMyPlan(p => ({ ...p, quarterly: v }))} />
              <PriceRow label={t('admin.membershipPriceYearly')} value={myPlan.yearly} placeholder={`推荐 ¥${suggested.yearly}`} onChange={v => setMyPlan(p => ({ ...p, yearly: v }))} />
            </div>
            <button onClick={saveMyPlan} disabled={savingPlan} className="mt-4 px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">{t('admin.saveSettings')}</button>
          </>
        )}
      </div>
    </div>
  );
}

function PriceRow({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <input type="number" step="0.01" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
        className="px-3 py-1.5 text-sm border rounded-lg w-32" />
    </div>
  );
}
