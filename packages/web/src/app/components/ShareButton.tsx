'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import useTranslation from '../../hooks/useTranslation';
import { useWechatShare } from '../../hooks/useWechatShare';

function isWechat(): boolean {
  return typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent);
}

export default function ShareButton() {
  const { t } = useTranslation();
  const pathname = usePathname() || '/';
  // 配置微信原生分享菜单（路由变化或详情页更新配置时自动重新签名）
  useWechatShare(pathname);

  const [showGuide, setShowGuide] = useState(false);
  const [toast, setToast] = useState('');

  const onClick = async () => {
    if (isWechat()) {
      setShowGuide(true);
      return;
    }
    // 非微信环境：复制当前链接
    const url = window.location.href.split('#')[0];
    try {
      await navigator.clipboard.writeText(url);
      setToast(t('share.copySuccess'));
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        setToast(t('share.copySuccess'));
      } catch {
        setToast(t('share.copyFailed'));
      } finally {
        const ta = document.querySelector('textarea');
        if (ta && ta.parentElement) ta.parentElement.removeChild(ta);
      }
    }
    setTimeout(() => setToast(''), 2200);
  };

  return (
    <>
      <button
        onClick={onClick}
        className="flex items-center gap-1 text-sm font-medium text-neutral-600 hover:text-brand-500 transition-colors"
        aria-label={t('share.button')}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        <span>{t('share.button')}</span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-xs w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2">{t('share.guideTitle')}</h3>
            <p className="text-sm text-neutral-600 leading-relaxed mb-4">{t('share.guideDesc')}</p>
            <button
              onClick={() => setShowGuide(false)}
              className="w-full py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
            >
              {t('share.guideClose')}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-neutral-900 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </>
  );
}
