'use client';

import { useEffect } from 'react';

// 微信绑定回调落地页：由 API 302 重定向至此（同源、打包 JS 不受 CSP 内联脚本限制）。
// 负责把绑定结果通过 postMessage 回传给「账号设置页」弹窗的父窗口，并关闭弹窗。
export default function WechatBindCallback() {
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const error = sp.get('error');
    const targetOrigin = window.location.origin;

    if (error) {
      if (window.opener) {
        window.opener.postMessage({ type: 'WECHAT_BIND_ERROR', message: error }, targetOrigin);
      } else {
        alert('微信绑定失败: ' + error);
      }
    } else {
      if (window.opener) {
        window.opener.postMessage({ type: 'WECHAT_BIND_DONE' }, targetOrigin);
      } else {
        alert('微信绑定成功');
      }
    }
    if (window.opener) window.close();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-neutral-500">
      绑定处理中...
    </div>
  );
}
