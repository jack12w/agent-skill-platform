'use client';

import useTranslation from '../../hooks/useTranslation';

/**
 * 页面底部风险说明（2026-11-10）。
 * 纯展示组件：无状态、无请求、无交互，三处引用共用同一份文案，
 * 避免三页各写一份导致日后文案漂移。文案在 locales 的 riskNotice.*，zh/en 同步。
 */
export default function RiskNotice() {
  const { t } = useTranslation();

  return (
    <section
      aria-label={t('riskNotice.title')}
      className="mt-12 rounded-2xl border border-neutral-200 bg-neutral-50 px-5 py-5 sm:px-6"
    >
      <h2 className="text-xs font-semibold tracking-wide text-neutral-500">
        {t('riskNotice.title')}
      </h2>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-neutral-500">
        <p>
          <span className="font-semibold text-neutral-700">{t('riskNotice.copyrightLabel')}</span>
          {t('riskNotice.copyrightText')}
        </p>
        <p>
          <span className="font-semibold text-neutral-700">{t('riskNotice.securityLabel')}</span>
          {t('riskNotice.securityText')}
        </p>
      </div>
    </section>
  );
}
