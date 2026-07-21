'use client';

import { useEffect, useState } from 'react';

// 健壮自关弹窗：直接 window.close() 在跨域 302 后常被浏览器静默拦截，
// 先跳到 about:blank（可被脚本关闭的特殊页）再 close；若仍关不掉则回调通知上层。
function selfCloseRobustly(onCannotClose?: () => void) {
  const tryClose = () => { try { window.close(); } catch {} };
  try {
    window.location.href = 'about:blank';
    setTimeout(() => {
      tryClose();
      setTimeout(() => { if (!window.closed) onCannotClose?.(); }, 300);
    }, 150);
  } catch {
    tryClose();
    setTimeout(() => { if (!window.closed) onCannotClose?.(); }, 300);
  }
}

// 微信绑定回调落地页：由 API 302 重定向至此（同源、打包 JS 不受 CSP 内联脚本限制）。
// 完成绑定后通过两条通道通知父窗口（账号设置页）：
//   1) postMessage 给 window.opener（快速通道，opener 存活时立即生效）
//   2) localStorage 写入 wechat_bind_event（兜底，跨标签页 storage 事件，不依赖 window.opener）
// 弹窗关闭统一由父窗口负责；本页也尝试自关作为额外兜底。
export default function WechatBindCallback() {
  const [tip, setTip] = useState('绑定处理中，请稍候…');

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const error = sp.get('error');

    const notifyParent = (payload: any) => {
      if (window.opener && window.opener !== window) {
        try { window.opener.postMessage(payload, window.location.origin); } catch {}
      }
      try {
        localStorage.setItem('wechat_bind_event', JSON.stringify({ ...payload, ts: Date.now() }));
      } catch {}
    };

    if (error) {
      notifyParent({ type: 'WECHAT_BIND_ERROR', message: error });
      if (!window.opener) { alert('微信绑定失败: ' + error); setTip('微信绑定失败: ' + error); return; }
      selfCloseRobustly(() => setTip('绑定完成，请手动关闭此窗口'));
    } else {
      notifyParent({ type: 'WECHAT_BIND_DONE' });
      if (!window.opener) { alert('微信绑定成功'); setTip('微信绑定成功'); return; }
      selfCloseRobustly(() => setTip('绑定完成，请手动关闭此窗口'));
    }
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-neutral-500">
      {tip}
    </div>
  );
}
