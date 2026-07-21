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
  const val = el?.content || '';
  if (!val) return '';
  if (content) return val;
  // og:image 仅用于分享缩略图：微信不支持 SVG。
  // 注意：Next.js 会基于 metadataBase 把相对 `/og-image.svg` 改写成绝对
  // `https://.../og-image.svg`，所以 SVG 判断必须在「是否 http(s)」之前、
  // 对绝对/相对地址一视同仁，否则绝对地址的 SVG 会漏过去传给微信 → 无图。
  if (/\.svg(\?|#|$)/i.test(val)) return '';
  if (!/^https?:\/\//i.test(val)) {
    return window.location.origin + (val.startsWith('/') ? '' : '/') + val;
  }
  return val;
}

function getDefaultOgImage(): string {
  // 浏览器端运行时永远用当前 origin，避免构建期 PUBLIC_BASE_URL 固化错误（如 https://localhost）
  // 导致默认图 URL 404，微信抓不到缩略图。
  const base = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_BASE_URL || '');
  return `${base}/og-image.png`;
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
      // ?wxdebug 打开微信 debug 弹窗，便于部署时定位 invalid signature 等错误
      const debug = /[?&]wxdebug(=|&|#|$)/.test(window.location.search);

      loadWx()
        .then((wx) => {
          if (cancelled || !wx) return;
          fetch(`/api/wechat/jssdk?url=${encodeURIComponent(url)}`)
            .then((r) => (r.ok ? r.json() : r.json().then((d: any) => Promise.reject(new Error(d?.message || `status ${r.status}`)))).catch(() => Promise.reject(new Error(`status ${r.status}`))))
            .then((data: any) => {
              if (cancelled) return;
              wx.config({
                debug,
                appId: data.appId,
                timestamp: data.timestamp,
                nonceStr: data.nonceStr,
                signature: data.signature,
                jsApiList: [
                  'updateAppMessageShareData',
                  'updateTimelineShareData',
                  // 已废弃但 PC 端 / 部分旧客户端仍有效，保留以兼容
                  'onMenuShareAppMessage',
                  'onMenuShareTimeline',
                ],
              });
              wx.ready(() => {
                const friendData = { title, desc, link, imgUrl };
                const timelineData = { title, link, imgUrl };
                // 新版接口（手机端主用）
                try { wx.updateAppMessageShareData(friendData); } catch {}
                try { wx.updateTimelineShareData(timelineData); } catch {}
                // 旧版接口（PC 端 / 旧客户端兼容，官方社区确认仍有效）
                try { wx.onMenuShareAppMessage(friendData); } catch {}
                try { wx.onMenuShareTimeline(timelineData); } catch {}
              });
              wx.error((err: any) => {
                console.error('[wechat-share] wx.config 失败:', err);
              });
            })
            .catch((e) => {
              console.error('[wechat-share] 获取签名失败:', e);
            });
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
