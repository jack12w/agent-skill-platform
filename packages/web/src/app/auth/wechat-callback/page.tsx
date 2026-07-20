'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 微信登录回调落地页：由 API 302 重定向至此（同源、打包 JS 不受 CSP 内联脚本限制）。
// 负责把 token/user 通过 postMessage 回传给登录页弹窗的父窗口，并关闭弹窗。
export default function WechatLoginCallback() {
  const router = useRouter();
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get('token');
    const user = sp.get('user');
    const error = sp.get('error');
    const targetOrigin = window.location.origin;

    if (error) {
      if (window.opener) {
        window.opener.postMessage({ type: 'WECHAT_LOGIN_ERROR', message: error }, targetOrigin);
      } else {
        alert('微信登录失败: ' + error);
      }
    } else if (token && user) {
      let parsedUser: any = null;
      try { parsedUser = JSON.parse(user); } catch { parsedUser = null; }
      if (window.opener) {
        window.opener.postMessage({ type: 'WECHAT_LOGIN', token, user: parsedUser }, targetOrigin);
      } else {
        // 非弹窗场景（直接打开此 URL）：本页完成登录后跳转
        localStorage.setItem('token', token);
        localStorage.setItem('user', user);
        router.push('/dashboard');
        return;
      }
    }
    if (window.opener) window.close();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-neutral-500">
      登录处理中...
    </div>
  );
}
