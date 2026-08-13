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
  // Cookie 来自最近一次登录/登出操作，优先级高于 localStorage；只要 Cookie 存在就同步，
  // 避免部分浏览器 302 后 localStorage 为空导致子组件误判未登录。
  if (ckToken) {
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

export function clearAuthCookies() {
  if (typeof document === 'undefined') return;
  document.cookie = 'token=; Path=/; Max-Age=0; SameSite=Lax';
  document.cookie = 'user=; Path=/; Max-Age=0; SameSite=Lax';
}

// 将登录态同时写入 Cookie（与 mp 静默登录通道一致），使任意页面在任意时刻都能从 Cookie 同步恢复，
// 不再依赖扫码弹窗的 postMessage / storage 异步通知链。user 传 JSON 字符串，由本函数统一编码。
export function setAuthCookie(token: string, userJson: string, maxAgeDays = 7) {
  if (typeof document === 'undefined') return;
  const maxAge = maxAgeDays * 24 * 60 * 60;
  document.cookie = `token=${token}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  document.cookie = `user=${encodeURIComponent(userJson)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
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

      // 检测到 401
      if (response.status === 401) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
        // 登录/注册接口本身返回 401（凭证错误）不视为登录态失效，避免死循环
        if (!url.includes('/auth/login') && !url.includes('/auth/register')) {
          // 关键：仅当本次请求「携带了登录态」(Authorization) 时，401 才说明 token 失效，
          // 应清登录态并跳登录。未携带 token 的「公开请求」(如订阅数、公开列表) 返回 401
          // 不应清登录态——否则会把游客/公开页的已登录用户误踢回登录页。
          const init = args[1] as { headers?: Record<string, string> | Headers } | undefined;
          const headers = init?.headers;
          const hasAuth =
            (!!headers && (headers as Record<string, string>).Authorization) ||
            (typeof Headers !== 'undefined' && headers instanceof Headers && !!headers.get('authorization'));
          if (hasAuth) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            clearAuthCookies();
            router.push('/auth');
          }
        }
      }

      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [router]);

  // 跨标签页兜底：扫码登录弹窗写入 wechat_login_event 后，即使 /auth 的监听偶发未接住，
  // 这里也从 Cookie 同步到 localStorage，确保任意页面登录态恢复（token 已落盘为 Cookie）。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'wechat_login_event' && e.newValue) {
        try {
          const data = JSON.parse(e.newValue);
          if (data.type === 'WECHAT_LOGIN') hydrateTokenFromCookie();
        } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 纯前端轮询兜底（服务器零负担）：同标签页写入 localStorage 不会触发 storage 事件，
  // 故以 setInterval 周期性「只读」本地 localStorage.getItem('wechat_login_event')，命中后从 Cookie
  // 同步登录态到 localStorage，并消费掉该事件避免重复触发。不发任何网络请求。
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const raw = localStorage.getItem('wechat_login_event');
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && data.type === 'WECHAT_LOGIN') {
          hydrateTokenFromCookie();
          localStorage.removeItem('wechat_login_event');
        } else if (data && data.type === 'WECHAT_LOGIN_ERROR') {
          // 仅清理残留事件（错误提示由 /auth 的 postMessage/storage 通道负责），避免长期滞留
          localStorage.removeItem('wechat_login_event');
        }
      } catch {}
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return <>{children}</>;
}
