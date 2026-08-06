'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

/**
 * 创作者会员定价编辑器（可复用）。
 * - 个人主页 owner 查看自己时、账号设置「会员定价」页、均可复用。
 * - targetType/targetId 决定编辑的是「用户」还是「团队」的会员套餐价。
 */
export default function MembershipPriceEditor({ targetType, targetId }: { targetType: 'user' | 'team'; targetId: string }) {
  const { t } = useTranslation();
  const [myPlan, setMyPlan] = useState({ monthly: '', quarterly: '', yearly: '' });
  const [suggested, setSuggested] = useState({ monthly: 29, quarterly: 79, yearly: 268 });
  const [planLoading, setPlanLoading] = useState(true);
  const [savingPlan, setSavingPlan] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const token = getToken();
    if (!token || !targetId) { setPlanLoading(false); return; }
    fetch(`/api/pay/membership/plan?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
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
            monthly: String(suggested.monthly),
            quarterly: String(suggested.quarterly),
            yearly: String(suggested.yearly),
          });
        }
      })
      .catch(() => {})
      .finally(() => setPlanLoading(false));
  }, [targetType, targetId]);

  const saveMyPlan = async () => {
    const token = getToken();
    if (!token || !targetId) return;
    setSavingPlan(true);
    setMsg('');
    const r = await fetch('/api/pay/membership/plan', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        targetType,
        targetId,
        monthly_cents: Math.round(Number(myPlan.monthly || 0) * 100),
        quarterly_cents: Math.round(Number(myPlan.quarterly || 0) * 100),
        yearly_cents: Math.round(Number(myPlan.yearly || 0) * 100),
      }),
    });
    setSavingPlan(false);
    setMsg(r.ok ? t('paySet.myPlanSaved') : '保存失败');
  };

  return (
    <div className="bg-white border rounded-xl p-5 max-w-md">
      <p className="text-xs text-brand-600 mb-3">{t('paySet.priceRecommended')}</p>
      {planLoading ? (
        <div className="text-sm text-neutral-400">加载中…</div>
      ) : (
        <>
          <div className="space-y-3">
            <PriceRow label={t('admin.membershipPriceMonthly')} value={myPlan.monthly} placeholder={`推荐 ¥${suggested.monthly}`} onChange={(v) => setMyPlan((p) => ({ ...p, monthly: v }))} />
            <PriceRow label={t('admin.membershipPriceQuarterly')} value={myPlan.quarterly} placeholder={`推荐 ¥${suggested.quarterly}`} onChange={(v) => setMyPlan((p) => ({ ...p, quarterly: v }))} />
            <PriceRow label={t('admin.membershipPriceYearly')} value={myPlan.yearly} placeholder={`推荐 ¥${suggested.yearly}`} onChange={(v) => setMyPlan((p) => ({ ...p, yearly: v }))} />
          </div>
          <button onClick={saveMyPlan} disabled={savingPlan} className="mt-4 px-4 py-1.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
            {t('admin.saveSettings')}
          </button>
        </>
      )}
      {msg && <div className="text-sm text-green-600 mt-3">{msg}</div>}
    </div>
  );
}

function PriceRow({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-600">{label}</span>
      <input
        type="number"
        step="0.01"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1.5 text-sm border rounded-lg w-32"
      />
    </div>
  );
}
