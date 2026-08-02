'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useTranslation from '../../hooks/useTranslation';

export default function AccountNav() {
  const pathname = usePathname();
  const { t } = useTranslation();

  // /en 前缀由中间件重写，这里统一去掉再比对高亮
  const current = (pathname || '').replace(/^\/en/, '') || '/';

  const items = [
    { href: '/account', label: t('avatar.account') },
    { href: '/account/orders', label: t('pay.ordersTitle') },
    { href: '/account/earnings', label: t('pay.earningsTitle') },
    { href: '/account/withdraw', label: t('pay.withdrawTitle') },
  ];

  return (
    <div className="flex flex-wrap gap-2 mb-6">
      {items.map((it) => {
        const active = current === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`px-3 py-1.5 rounded-lg text-sm border transition ${
              active
                ? 'border-brand-600 bg-brand-50 text-brand-700 font-medium'
                : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
