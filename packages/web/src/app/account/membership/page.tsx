'use client';

import useTranslation from '../../../hooks/useTranslation';
import AccountNav from '../../components/AccountNav';
import MembershipPriceEditor from '../../components/MembershipPriceEditor';

function getUserId() { try { return JSON.parse(localStorage.getItem('user') || 'null')?.id || null; } catch { return null; } }

export default function MembershipPricingPage() {
  const { t } = useTranslation();
  const me = getUserId();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <AccountNav />
      <h1 className="text-2xl font-bold mb-1">{t('paySet.myMembershipTitle')}</h1>
      <p className="text-sm text-neutral-500 mb-6">{t('paySet.myMembershipHint')}</p>

      {me ? (
        <MembershipPriceEditor targetType="user" targetId={me} />
      ) : (
        <div className="text-sm text-neutral-400">请先登录</div>
      )}
    </div>
  );
}
