'use client';

import { useEffect } from 'react';
import { getShareConfig, subscribeShareConfig } from '../lib/share';

let sdkPromise: Promise<any> | null = null;

function loadWx(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject();
  const w = window as any;
  if (w.wx) return Promise.resolve(w.wx);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
    script.onload = () => resolve((window as any).wx);
    script.onerror = () => reject(new Error('jweixin load failed'));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function readMeta(content: boolean): string {
  if (typeof document === 'undefined') return '';
  const sel = content ? 'meta[property="og:description"], meta[name="description"]' : 'meta[property="og:image"]';
  const el = document.querySelector(sel) as HTMLMetaElement | null;
  return el?.content || '';
}

function getDefaultOgImage(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || window.location.origin;
  return `${base}/og-image.svg`;
}

/**
 * 配置微信原生分享菜单（发送给朋友 / 分享到朋友圈）。
 * 内容优先级：详情页显式 setShareConfig > 页面 meta > document.title / 默认图。
 * 在路由变化或详情页更新配置时自动重新签名。
 */
export function useWechatShare(pathname: string) {
  useEffect(() => {
    let cancelled = false;

    const configure = () => {
      const cfg = getShareConfig();
      const title = cfg.title || document.title || 'SkillDepot';
      const desc = cfg.desc || readMeta(true) || title;
      const link = window.location.href.split('#')[0];
      const imgUrl = cfg.imgUrl || readMeta(false) || getDefaultOgImage();
      const url = link;

      loadWx()
        .then((wx) => {
          if (cancelled || !wx) return;
          fetch(`/api/wechat/jssdk?url=${encodeURIComponent(url)}`)
            .then((r) => (r.ok ? r.json() : Promise.reject()))
            .then((data: any) => {
              if (cancelled) return;
              wx.config({
                debug: false,
                appId: data.appId,
                timestamp: data.timestamp,
                nonceStr: data.nonceStr,
                signature: data.signature,
                jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData'],
              });
              wx.ready(() => {
                wx.updateAppMessageShareData({ title, desc, link, imgUrl });
                wx.updateTimelineShareData({ title, link, imgUrl });
              });
            })
            .catch(() => {});
        })
        .catch(() => {});
    };

    configure();
    const unsub = subscribeShareConfig(() => {
      if (!cancelled) configure();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [pathname]);
}
