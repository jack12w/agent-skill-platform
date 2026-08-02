'use client';

import useTranslation from '../../hooks/useTranslation';

export default function AgreementPage() {
  const { t } = useTranslation();
  const sections = [
    ['agreement.s1Title', 'agreement.s1Body'],
    ['agreement.s2Title', 'agreement.s2Body'],
    ['agreement.s3Title', 'agreement.s3Body'],
    ['agreement.s4Title', 'agreement.s4Body'],
    ['agreement.s5Title', 'agreement.s5Body'],
    ['agreement.s6Title', 'agreement.s6Body'],
    ['agreement.s7Title', 'agreement.s7Body'],
  ];
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold mb-1">{t('agreement.title')}</h1>
      <p className="text-xs text-neutral-400 mb-6">{t('agreement.updated')}</p>
      <p className="text-sm text-neutral-700 leading-relaxed mb-6">{t('agreement.intro')}</p>
      <div className="space-y-5">
        {sections.map(([titleKey, bodyKey]) => (
          <section key={titleKey}>
            <h2 className="text-base font-semibold mb-1">{t(titleKey)}</h2>
            <p className="text-sm text-neutral-600 leading-relaxed">{t(bodyKey)}</p>
          </section>
        ))}
      </div>
      <div className="mt-8 p-4 rounded-lg bg-neutral-50 border text-sm">
        <a href="/help" className="text-brand-600 hover:underline font-medium">
          {t('agreement.termsLink')}
        </a>
      </div>
    </div>
  );
}
