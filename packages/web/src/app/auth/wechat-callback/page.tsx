'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 微信登录回调落地页：由 API 302 重定向至此（同源、打包 JS 不受 CSP 内联脚本限制）。
// 完成登录后通过两条通道通知父窗口：
//   1) postMessage 给 window.opener（快速通道，opener 存活时立即生效）
//   2) localStorage 写入 wechat_login_event（兜底，跨标签页 storage 事件，不依赖 window.opener）
// 弹窗关闭统一由父窗口（window.open 创建者）负责；本页尝试自关作为额外兜底。
export default function WechatLoginCallback() {
  const router = useRouter();
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get('token');
    const user = sp.get('user');
    const error = sp.get('error');

    const notifyParent = (payload: any) => {
      // 通道 1：opener 存在且非自身时 postMessage
      if (window.opener && window.opener !== window) {
        try { window.opener.postMessage(payload, window.location.origin); } catch {}
      }
      // 通道 2：写入 localStorage，父窗口通过 storage 事件收到（带 ts 保证每次值不同都能触发）
      try {
        localStorage.setItem('wechat_login_event', JSON.stringify({
          type: payload.type,
          token: payload.token,
          user: payload.user,
          message: payload.message,
          ts: Date.now(),
        }));
      } catch {}
    };

    if (error) {
      notifyParent({ type: 'WECHAT_LOGIN_ERROR', message: error });
      if (!window.opener) alert('微信登录失败: ' + error);
      setTimeout(() => { try { window.close(); } catch {} }, 300);
      return;
    }

    if (token && user) {
      let parsedUser: any = null;
      try { parsedUser = JSON.parse(user); } catch {}
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
      notifyParent({ type: 'WECHAT_LOGIN', token, user: parsedUser });
      // 无 opener（用户直接打开此 URL）：本页完成登录后跳转
      if (!window.opener) {
        router.push('/dashboard');
        return;
      }
      // 有 opener：由父窗口负责跳转并关闭弹窗；本页稍后尝试自关作为兜底
      setTimeout(() => { try { window.close(); } catch {} }, 300);
      return;
    }

    // 没有任何参数：异常，无 opener 时退回登录页
    if (!window.opener) router.push('/auth');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-neutral-500">
      登录处理中，请稍候…
    </div>
  );
}
