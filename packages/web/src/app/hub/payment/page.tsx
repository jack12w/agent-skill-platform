'use client';

import { useState, useEffect } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import OrdersPanel from './orders-panel';
import MembershipsPanel from './memberships-panel';
import BalancesPanel from './balances-panel';
import WithdrawalsPanel from './withdrawals-panel';
import ReconciliationPanel from './reconciliation-panel';
import PaySettingsPanel from './pay-settings-panel';

const TABS = [
  { key: 'orders', label: 'admin.orders', Panel: OrdersPanel },
  { key: 'memberships', label: 'admin.memberships', Panel: MembershipsPanel },
  { key: 'balances', label: 'admin.balances', Panel: BalancesPanel },
  { key: 'withdrawals', label: 'admin.withdrawals', Panel: WithdrawalsPanel },
  { key: 'reconciliation', label: 'admin.reconciliation', Panel: ReconciliationPanel },
  { key: 'pay-settings', label: 'admin.paySettings', Panel: PaySettingsPanel },
];

export default function HubPaymentPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState('orders');

  useEffect(() => {
    const hash = window.location.hash?.replace('#', '');
    if (hash && TABS.some(x => x.key === hash)) setActive(hash);
  }, []);

  const switchTab = (k: string) => {
    setActive(k);
    window.location.hash = k;
  };

  const ActivePanel = TABS.find(x => x.key === active)!.Panel;

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.payment')}</h1>

      <div className="flex gap-1 mb-5 border-b border-neutral-200 overflow-x-auto">
        {TABS.map(tab => (
          <button key={tab.key} onClick={() => switchTab(tab.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors ${
              active === tab.key
                ? 'border-brand-600 text-brand-700 font-medium'
                : 'border-transparent text-neutral-600 hover:text-neutral-900'
            }`}>
            {t(tab.label)}
          </button>
        ))}
      </div>

      <ActivePanel />
    </div>
  );
}
