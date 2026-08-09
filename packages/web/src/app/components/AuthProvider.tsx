'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

function getCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : undefined;
}

// 微信内静默登录：后端经 302 + Cookie 下发 token/user，此处在「渲染期」同步回 localStorage
// （前端所有页面统一读 localStorage）。放在渲染期而非 effect，确保子组件读取前已就绪，
// 避免目标页首屏因读不到 token 又跳回登录页。
function hydrateTokenFromCookie() {
  if (typeof window === 'undefined') return;
  const ckToken = getCookie('token');
  if (ckToken && !localStorage.getItem('token')) {
    localStorage.setItem('token', ckToken);
    const ckUser = getCookie('user');
    if (ckUser) {
      try {
        localStorage.setItem('user', decodeURIComponent(ckUser));
      } catch {
        /* 解析失败忽略 */
      }
    }
  }
}

function clearAuthCookies() {
  if (typeof document === 'undefined') return;
  document.cookie = 'token=; Path=/; Max-Age=0; SameSite=Lax';
  document.cookie = 'user=; Path=/; Max-Age=0; SameSite=Lax';
}

/**
 * 全局 401 拦截器：监听所有 fetch 请求，当后端返回 401 时自动清除本地 token
 * 并跳转到登录页。
 */
export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // 渲染期把微信静默登录下发的 Cookie 同步进 localStorage（仅首次、仅当 localStorage 为空）
  hydrateTokenFromCookie();

  useEffect(() => {
    const originalFetch = window.fetch;

    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);

      // 检测到 401 → token 过期或无效
      if (response.status === 401) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
        // 避免登录接口本身返回 401 时陷入死循环
        if (!url.includes('/auth/login') && !url.includes('/auth/register')) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          clearAuthCookies();
          router.push('/auth');
        }
      }

      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [router]);

  return <>{children}</>;
}
