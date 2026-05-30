'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 全局 401 拦截器：监听所有 fetch 请求，当后端返回 401 时自动清除本地 token
 * 并跳转到登录页。
 */
export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();

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
