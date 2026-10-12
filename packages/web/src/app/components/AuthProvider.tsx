'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 读同源 Cookie。导出供登录落地页复用（/auth/wechat-callback 从 cookie 取服务端下发的
 * token/user，见 api auth.controller wechatCallback）——避免第二个实现走偏。
 */
export function getCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : undefined;
}

/**
 * 还原服务端下发的 `user` cookie 为原始 JSON 字符串。
 *
 * 约定：cookie 值 = encodeURIComponent(JSON)。但 2026-10-12 之前服务端写成
 * 「手工 encodeURIComponent 后再交给 express res.cookie」，express 默认还会再编码一次
 * → 落盘值是 `%257B...`（二次编码）。只 decode 一层会得到 `%7B...`，`JSON.parse`
 * 失败 → 登录对象整个丢失（依赖它的 `getUserId()` 恒为 null）。
 * 这里「一直解码到能解析为 JSON 为止」（最多两层）：新旧 cookie 都能正确还原，
 * 不必等旧 cookie 的 7 天有效期自然过期。解不出来就原样返回，交给调用方兜底。
 */
export function decodeCookieJson(raw: string): string {
  let v = raw;
  for (let i = 0; i < 2; i++) {
    try {
      JSON.parse(v);
      return v;
    } catch {
      /* 还不是 JSON：再解一层编码 */
    }
    try {
      v = decodeURIComponent(v);
    } catch {
      return v; // 非法百分号序列 → 原样返回
    }
  }
  return v;
}

// 微信内静默登录：后端经 302 + Cookie 下发 token/user，此处在「渲染期」同步回 localStorage
// （前端所有页面统一读 localStorage）。放在渲染期而非 effect，确保子组件读取前已就绪，
// 避免目标页首屏因读不到 token 又跳回登录页。
function hydrateTokenFromCookie() {
  if (typeof window === 'undefined') return;
  const ckToken = getCookie('token');
  if (!ckToken) return;

  // ⚠️ 只在「Cookie 的 token 与本地不同」时才覆盖本地。
  //
  // 本函数在每次渲染时调用。若像原先那样「只要 Cookie 有 token 就无条件覆盖」，
  // 任何只更新了 localStorage 而没同步 Cookie 的操作都会在下次渲染被静默回滚：
  //   - 合并账号后拿到新 token（只写 localStorage）→ 被旧 Cookie 覆盖回旧账号
  //   - 换头像 / 改昵称 / 改简介后（只更新 localStorage 的 user）→ 刷新后回到旧资料
  // 这类「改了又变回去」的问题极难排查，因为没有任何报错。
  //
  // 改为按 token 判定：
  //   - token 不同 → Cookie 是微信静默登录通道的**下发源**，说明发生了一次新的登录，以它为准。
  //   - token 相同 → 同一次登录会话，本地的 user 可能已被前端更新过，保留本地值不动。
  if (localStorage.getItem('token') === ckToken) return;

  localStorage.setItem('token', ckToken);
  const ckUser = getCookie('user');
  if (ckUser) {
    // 走 decodeCookieJson 而非单层 decodeURIComponent：兼容 2026-10-12 之前落下的
    // 二次编码 cookie（服务端 bug，见该函数注释），否则这里存进 localStorage 的是
    // `%7B...` 字符串，JSON.parse(localStorage.user) 全线失败。
    try {
      localStorage.setItem('user', decodeCookieJson(ckUser));
    } catch {
      /* 解析失败忽略 */
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

// ── 邀请归因（迁移 0034，2026-10-12）──
// 链路：邀请链接 /plugins?ref=CODE → captureReferral 存 30 天 →
//   ① 邮箱注册：/auth 注册请求直接带上（getPendingReferral）；
//   ② 微信路径：建号时拿不到 ref，登录态就绪后由 AuthProvider 轮询 claim 补绑。
const REFERRAL_KEY = 'referral_pending';
const REFERRAL_TTL = 30 * 86400_000; // 归因窗口 30 天

/** 捕获邀请码（落地页读 ?ref= 后调用）；带时间戳，30 天过期 */
export function captureReferral(code: string) {
  if (typeof window === 'undefined' || !code) return;
  try {
    localStorage.setItem(
      REFERRAL_KEY,
      JSON.stringify({ code: code.slice(0, 32), ts: Date.now() }),
    );
  } catch {
    /* 隐私模式等 localStorage 不可用 → 放弃归因，不影响主流程 */
  }
}

/** 读取未过期的邀请码；无/已过期 → null（过期时顺手清理） */
export function getPendingReferral(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(REFERRAL_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.code || Date.now() - Number(data.ts || 0) > REFERRAL_TTL) {
      localStorage.removeItem(REFERRAL_KEY);
      return null;
    }
    return String(data.code);
  } catch {
    return null;
  }
}

/** 消费邀请码：绑定成功或确定失败后调用，避免重复请求 */
export function clearPendingReferral() {
  try {
    localStorage.removeItem(REFERRAL_KEY);
  } catch {}
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

  // 邀请归因补绑（迁移 0034）：微信注册路径建号时拿不到 ref，登录态就绪后由这里补绑。
  // 仅当本地有待消费邀请码时才发请求；后端幂等（只绑 referred_by IS NULL 且注册 7 天内账号，
  // 不能自邀），重复调用无副作用。200（无论 bound 与否）和 4xx 都是确定结果 → 清码；
  // 5xx/网络错误保留待下次。interval 常驻但空转成本只是读一次 localStorage。
  useEffect(() => {
    const tryClaim = () => {
      try {
        const token = localStorage.getItem('token');
        const code = getPendingReferral();
        if (!token || !code) return;
        fetch('/api/auth/referral/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ referral_code: code }),
        })
          .then((res) => {
            if (res.status < 500) clearPendingReferral();
          })
          .catch(() => {
            /* 网络错误 → 保留邀请码等下轮 */
          });
      } catch {}
    };
    tryClaim();
    const timer = setInterval(tryClaim, 5000);
    return () => clearInterval(timer);
  }, []);

  return <>{children}</>;
}
