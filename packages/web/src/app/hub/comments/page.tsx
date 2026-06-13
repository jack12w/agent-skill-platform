'use client';

import useTranslation from '../../../hooks/useTranslation';

export default function HubCommentsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{t('admin.comments')}</h1>
      <p className="text-sm text-gray-500">{t('admin.overview')}</p>
      <div className="mt-8 text-center py-16 text-gray-400 text-sm">即将实现</div>
    </div>
  );
}
