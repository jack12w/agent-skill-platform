'use client';

import { useEffect, useState } from 'react';
import { setAuthCookie, getCookie, decodeCookieJson } from '../../components/AuthProvider';

// 健壮自关弹窗：直接 window.close() 在跨域 302（open.weixin.qq.com）后常被浏览器静默拦截。
// 本页反复尝试多种关闭技巧，仍关不掉则明确提示用户手动关闭，绝不再把弹窗重定向到 dashboard。
function closeSelf() {
  try { window.close(); } catch {}
  try { window.open('', '_self')?.close(); } catch {}
  try { window.open('about:blank', '_self'); } catch {}
  try { window.location.replace('about:blank'); } catch {}
}

export default function WechatLoginCallback() {
  const [tip, setTip] = useState('登录处理中，请稍候…');
  const [showClose, setShowClose] = useState(false);

  useEffect(() => {
    // 安全网标记：一旦本页作为微信登录弹窗加载，就在 sessionStorage 留下标记，
    // 即便浏览器缓存或异常导致本页落到 dashboard，dashboard 也能识别并自关。
    try { sessionStorage.setItem('wechat_login_popup', '1'); } catch {}

    const sp = new URLSearchParams(window.location.search);
    const error = sp.get('error');
    /* 凭证来源（2026-10-12）：服务端改为 Set-Cookie 下发 token/user 并 302 到本页
     * （见 api auth.controller wechatCallback）——URL 不再携带 JWT，避免被网关访问日志、
     * 浏览器历史与子请求 Referer 持久落盘。本页主通道改为读同源 Cookie。
     *
     * 顺序：**query 优先，cookie 兜底**。
     *   - query 是「本次扫码这一次尝试」的明确结果（仅旧后端/部署切换瞬间会出现）；
     *   - cookie 是浏览器环境态（可能是上一次会话留下的旧 token）。
     *   两者冲突只可能发生在前后端不同版本混跑的瞬间，此时以本次尝试为准才不会
     *   用上一段会话的旧身份完成登录（否则扫 B 号却登进 A 号）。
     *   新链路下 query 不带 token/user，自然落到 cookie 分支。
     * 两者都读不到才判定参数缺失。 */
    const ckUserRaw = getCookie('user');
    // Cookie 里的 user 是编码过的 JSON；用 decodeCookieJson（而非单层 decode）兼容
    // 服务端改造前落下的二次编码 cookie，详见该函数注释。
    const ckUser = ckUserRaw ? decodeCookieJson(ckUserRaw) : null;
    const token = sp.get('token') || getCookie('token');
    const user = sp.get('user') || ckUser;

    const notifyParent = (payload: any) => {
      try {
        if (window.opener && window.opener !== window && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
        }
      } catch {}
      try {
        localStorage.setItem('wechat_login_event', JSON.stringify({ ...payload, ts: Date.now() }));
      } catch {}
    };

    if (error) {
      setTip('微信登录失败：' + error);
      notifyParent({ type: 'WECHAT_LOGIN_ERROR', message: error });
      let attempts = 0;
      const timer = setInterval(() => {
        closeSelf();
        attempts += 1;
        if (window.closed || attempts > 15) {
          clearInterval(timer);
          if (!window.closed) setShowClose(true);
        }
      }, 200);
      return () => clearInterval(timer);
    }

    if (token && user) {
      let parsedUser: any = null;
      try { parsedUser = JSON.parse(user); } catch {}
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
      setAuthCookie(token, user);
      notifyParent({ type: 'WECHAT_LOGIN', token, user: parsedUser });
      setTip('登录成功，正在关闭窗口…');

      let attempts = 0;
      const timer = setInterval(() => {
        closeSelf();
        attempts += 1;
        if (window.closed || attempts > 15) {
          clearInterval(timer);
          if (!window.closed) {
            setTip('登录成功，如窗口未自动关闭，请手动关闭此窗口');
            setShowClose(true);
          }
        }
      }, 200);
      return () => clearInterval(timer);
    }

    // 没有任何参数：异常
    setTip('登录参数缺失，请关闭此窗口并重新扫码登录。');
    setShowClose(true);
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
