'use client';

import { useEffect, useState } from 'react';

// 健壮自关弹窗：直接 window.close() 在跨域 302 后常被浏览器静默拦截。
// 本页反复尝试多种关闭技巧，仍关不掉则明确提示用户手动关闭，绝不再把弹窗重定向到其它页面。
function closeSelf() {
  try { window.close(); } catch {}
  try { window.open('', '_self')?.close(); } catch {}
  try { window.open('about:blank', '_self'); } catch {}
  try { window.location.replace('about:blank'); } catch {}
}

export default function WechatBindCallback() {
  const [tip, setTip] = useState('绑定处理中，请稍候…');
  const [showClose, setShowClose] = useState(false);

  useEffect(() => {
    // 安全网标记：一旦本页作为微信绑定弹窗加载，就在 sessionStorage 留下标记，
    // 即便浏览器缓存或异常导致本页落到 dashboard，dashboard 也能识别并自关。
    try { sessionStorage.setItem('wechat_bind_popup', '1'); } catch {}

    const sp = new URLSearchParams(window.location.search);
    const error = sp.get('error');

    const notifyParent = (payload: any) => {
      try {
        if (window.opener && window.opener !== window && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
        }
      } catch {}
      try {
        localStorage.setItem('wechat_bind_event', JSON.stringify({ ...payload, ts: Date.now() }));
      } catch {}
    };

    if (error) {
      setTip('微信绑定失败：' + error);
      notifyParent({ type: 'WECHAT_BIND_ERROR', message: error });
    } else {
      setTip('绑定成功，正在关闭窗口…');
      notifyParent({ type: 'WECHAT_BIND_DONE' });
    }

    let attempts = 0;
    const timer = setInterval(() => {
      closeSelf();
      attempts += 1;
      if (window.closed || attempts > 15) {
        clearInterval(timer);
        if (!window.closed) {
          setTip(error ? '绑定失败，如窗口未自动关闭，请手动关闭此窗口' : '绑定成功，如窗口未自动关闭，请手动关闭此窗口');
          setShowClose(true);
        }
      }
    }, 200);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-sm text-neutral-500 p-6">
      <p className="mb-4">{tip}</p>
      {showClose && (
        <button
          onClick={() => {
            closeSelf();
            setTip('如果仍未关闭，请直接点击浏览器右上角 × 关闭本窗口。');
          }}
          className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          关闭窗口
        </button>
      )}
    </div>
  );
}
