'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import QRCode from 'qrcode';
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

  const [show, setShow] = useState(false);
  const [qrUrl, setQrUrl] = useState<string>('');
  const [toast, setToast] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pageUrl = typeof window !== 'undefined' ? window.location.href.split('#')[0] : '';

  useEffect(() => {
    if (!pageUrl || isWechat()) return;
    let cancelled = false;
    QRCode.toDataURL(pageUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) setQrUrl(url);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, [pageUrl]);

  const cancelDelayedClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const open = () => {
    cancelDelayedClose();
    setShow(true);
  };

  const close = () => {
    cancelDelayedClose();
    setShow(false);
  };

  const delayedClose = () => {
    cancelDelayedClose();
    closeTimer.current = setTimeout(() => setShow(false), 150);
  };

  // 点击面板外部关闭
  useEffect(() => {
    if (!show) return;
    const handle = (e: Event) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('touchstart', handle);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('touchstart', handle);
    };
  }, [show]);

  const copyLink = async () => {
    if (!pageUrl) return;
    try {
      await navigator.clipboard.writeText(pageUrl);
      setToast(t('share.copySuccess'));
    } catch {
      setToast(t('share.copyFailed'));
    }
    setTimeout(() => setToast(''), 2200);
  };

  return (
    <>
      <div
        className="relative"
        onMouseEnter={open}
        onMouseLeave={delayedClose}
      >
        <button
          onClick={open}
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

        {show && (
          <div
            ref={panelRef}
            className="absolute right-0 top-full mt-2 w-[280px] z-[60] bg-white border border-neutral-200 rounded-xl shadow-xl p-4 text-center"
            onMouseEnter={cancelDelayedClose}
          >
            <h3 className="text-sm font-semibold text-neutral-800 mb-1">
              {isWechat() ? t('share.guideTitle') : t('share.scanToShare')}
            </h3>
            {isWechat() ? (
              <p className="text-xs text-neutral-600 leading-relaxed">
                {t('share.guideDesc')}
              </p>
            ) : (
              <>
                {qrUrl ? (
                  <img
                    src={qrUrl}
                    alt="QR Code"
                    className="w-52 h-52 mx-auto mt-2 rounded-lg border border-neutral-100"
                  />
                ) : (
                  <div className="w-52 h-52 mx-auto mt-2 rounded-lg bg-neutral-100 animate-pulse" />
                )}
                <p className="text-xs text-neutral-500 mt-2 mb-2">
                  {t('share.scanDesc')}
                </p>
                <button
                  type="button"
                  onClick={copyLink}
                  className="text-xs text-brand-600 hover:text-brand-700 font-medium"
                >
                  {t('share.copyLink')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-neutral-900 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </>
  );
}
