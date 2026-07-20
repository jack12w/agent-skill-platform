'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface MeUser {
  id: string;
  email: string | null;
  name: string;
  avatar_url?: string;
  bio?: string;
  tags?: string[];
  role?: string;
  wechatBound?: boolean;
  emailVerified?: boolean;
  hasPassword?: boolean;
}

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);
  // 微信登录总开关（构建期注入）。关闭时隐藏「绑定微信」入口
  const wechatEnabled = process.env.NEXT_PUBLIC_WECHAT_LOGIN_ENABLED === 'true';

  // 微信绑定弹窗
  const [wechatLoading, setWechatLoading] = useState(false);
  // 邮箱绑定表单
  const [emailForm, setEmailForm] = useState({ email: '', code: '', password: '' });
  const [emailSending, setEmailSending] = useState(false);
  const [emailCountdown, setEmailCountdown] = useState(0);
  const [emailLoading, setEmailLoading] = useState(false);
  // 密码表单
  const [showPwd, setShowPwd] = useState(false);
  const [pwd, setPwd] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);

  const reloadMe = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      setMe(data);
      const prev = JSON.parse(localStorage.getItem('user') || '{}');
      const fresh = { ...prev, ...data };
      localStorage.setItem('user', JSON.stringify(fresh));
      window.dispatchEvent(new Event('user-updated'));
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.replace('/auth'); return; }
    reloadMe().finally(() => setLoading(false));
  }, [reloadMe, router]);

  useEffect(() => {
    if (emailCountdown <= 0) return;
    const t = setTimeout(() => setEmailCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [emailCountdown]);

  const handleBindWechat = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setWechatLoading(true);
    try {
      const res = await fetch('/api/auth/wechat/bind-url', { headers: { Authorization: `Bearer ${token}` } });
      const { url } = await res.json();
      const w = 600, h = 700;
      const left = Math.max(0, (window.screen.availWidth - w) / 2);
      const top = Math.max(0, (window.screen.availHeight - h) / 2);
      const win = window.open(url, 'wechat_bind', `width=${w},height=${h},left=${left},top=${top}`);
      if (!win) { alert('请允许弹窗以完成微信绑定'); return; }
      const onMsg = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === 'WECHAT_BIND_DONE') {
          try { win.close(); } catch {}
          window.removeEventListener('message', onMsg);
          reloadMe();
          alert('微信绑定成功');
        } else if (e.data?.type === 'WECHAT_BIND_ERROR') {
          try { win.close(); } catch {}
          window.removeEventListener('message', onMsg);
          alert('微信绑定失败: ' + (e.data.message || '未知错误'));
        }
      };
      window.addEventListener('message', onMsg);
    } catch {
      alert('微信绑定失败');
    } finally {
      setWechatLoading(false);
    }
  };

  const handleSendCode = async () => {
    if (!emailForm.email) return;
    setEmailSending(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailForm.email }),
      });
      const data = await res.json();
      if (res.ok) {
        setEmailCountdown(60);
        if (data.code) setEmailForm((f) => ({ ...f, code: data.code }));
      } else {
        alert(data.message || '发送失败');
      }
    } catch {
      alert('发送失败');
    } finally {
      setEmailSending(false);
    }
  };

  const handleBindEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    if (!token) return;
    if (!emailForm.code) { alert('请输入验证码'); return; }
    setEmailLoading(true);
    try {
      const res = await fetch('/api/auth/bind-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: emailForm.email, code: emailForm.code, password: emailForm.password || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      if (data.merged) {
        localStorage.setItem('token', data.access_token);
        localStorage.setItem('user', JSON.stringify(data.user));
        window.dispatchEvent(new Event('user-updated'));
        alert('已自动合并到原邮箱账号');
      } else {
        alert('邮箱绑定成功');
      }
      setEmailForm({ email: '', code: '', password: '' });
      reloadMe();
    } catch (err: any) {
      alert('绑定失败: ' + (err.message || String(err)));
    } finally {
      setEmailLoading(false);
    }
  };

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    if (!token) return;
    if (!pwd) { alert('请输入新密码'); return; }
    setPwdLoading(true);
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: pwd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      alert('密码设置成功，现在可用邮箱+密码登录');
      setPwd('');
      setShowPwd(false);
      reloadMe();
    } catch (err: any) {
      alert('设置失败: ' + (err.message || String(err)));
    } finally {
      setPwdLoading(false);
    }
  };

  if (loading) {
    return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-neutral-400">加载中...</div>;
  }

  const initial = (me?.name || me?.email || 'U')[0]?.toUpperCase();

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <div className="flex items-center gap-3 mb-6">
        {me?.avatar_url ? (
          <img src={me.avatar_url} alt={me.name} className="w-14 h-14 rounded-full object-cover" />
        ) : (
          <div className="w-14 h-14 rounded-full bg-brand-600 text-white flex items-center justify-center text-xl font-bold">{initial}</div>
        )}
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">{me?.name}</h1>
          <p className="text-sm text-neutral-500">{me?.email || '未绑定邮箱'}</p>
        </div>
      </div>

      {!me?.emailVerified && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          你当前未绑定邮箱，订阅更新将通过<strong>站内通知</strong>推送。绑定邮箱后可接收<strong>邮件通知</strong>，并支持邮箱+密码登录。
        </div>
      )}

      <section className="bg-white border rounded-lg p-5 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-neutral-900">微信账号</h2>
            <p className="text-sm text-neutral-500 mt-0.5">{me?.wechatBound ? '已绑定微信' : '未绑定微信'}</p>
          </div>
          {me?.wechatBound ? (
            <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-sm">已绑定</span>
          ) : wechatEnabled ? (
            <button
              onClick={handleBindWechat}
              disabled={wechatLoading}
              className="px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 1024 1024" fill="currentColor">
                <path d="M669.3 369.4c9.8 0 19.6 0 29.4 1.6C671 245.2 536.9 152 383.2 152 211.6 152 71 269.7 71 416.8c0 85 45.8 156.9 124.2 210.9l-31.1 93.2L273.6 667c39.2 8.2 70.3 16.3 109.5 16.3 9.8 0 19.6 0 31.1-1.6-6.5-21.3-9.8-42.5-9.8-65.4 0.1-135.7 116.2-246.9 264.9-246.9z m-168.4-85c24.5 0 39.2 16.3 39.2 39.2 0 22.9-16.3 39.2-39.2 39.2-24.5 0-47.4-16.4-47.4-39.2 0-24.5 24.6-39.2 47.4-39.2z m-216.3 73.1c-24.7 0-47.8-16.2-47.8-38.8 0-24.3 24.7-38.8 47.8-38.8s39.5 16.2 39.5 38.8c0.1 22.7-16.4 38.8-39.5 38.8z" />
                <path d="M953.8 613c0-125.9-124.2-227.2-264.8-227.2-148.8 0-266.5 103-266.5 227.2 0 125.9 117.7 227.2 266.5 227.2 31.1 0 62.1-8.2 93.2-16.3l85 47.4-22.9-78.5c62.1-47.4 109.5-109.5 109.5-179.8z m-351.5-39.2c-14.7 0-31.1-14.7-31.1-31.1 0-14.7 16.3-31.1 31.1-31.1 22.9 0 39.2 16.3 39.2 31.1 0 16.4-14.7 31.1-39.2 31.1z m178-7.6c-14.8 0-31.3-14.6-31.3-30.7 0-14.6 16.5-30.7 31.3-30.7 23.1 0 39.5 16.2 39.5 30.7 0 16.2-16.4 30.7-39.5 30.7z" />
              </svg>
              {wechatLoading ? '...' : '绑定微信'}
            </button>
          ) : (
            <span className="px-3 py-1 bg-neutral-100 text-neutral-400 rounded-full text-sm">未启用</span>
          )}
        </div>
      </section>

      <section className="bg-white border rounded-lg p-5 mb-4">
        <h2 className="font-semibold text-neutral-900">邮箱</h2>
        {me?.emailVerified ? (
          <p className="text-sm text-neutral-500 mt-1">已绑定：{me.email}（已验证）</p>
        ) : (
          <form onSubmit={handleBindEmail} className="mt-3 space-y-3">
            <input
              type="email"
              required
              placeholder="邮箱"
              className="w-full px-3 py-2 border rounded-lg"
              value={emailForm.email}
              onChange={(e) => setEmailForm({ ...emailForm, email: e.target.value })}
            />
            <div className="flex gap-2">
              <input
                type="text"
                required
                maxLength={6}
                placeholder="验证码"
                className="flex-1 px-3 py-2 border rounded-lg"
                value={emailForm.code}
                onChange={(e) => setEmailForm({ ...emailForm, code: e.target.value })}
              />
              <button
                type="button"
                onClick={handleSendCode}
                disabled={emailSending || emailCountdown > 0 || !emailForm.email}
                className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {emailSending ? '...' : emailCountdown > 0 ? `${emailCountdown}s` : '获取验证码'}
              </button>
            </div>
            <input
              type="password"
              placeholder="设置密码（可选，绑定后可邮箱登录）"
              className="w-full px-3 py-2 border rounded-lg"
              value={emailForm.password}
              onChange={(e) => setEmailForm({ ...emailForm, password: e.target.value })}
            />
            <button
              type="submit"
              disabled={emailLoading}
              className="w-full py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {emailLoading ? '绑定中...' : '绑定邮箱'}
            </button>
          </form>
        )}
      </section>

      <section className="bg-white border rounded-lg p-5 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-neutral-900">登录密码</h2>
            <p className="text-sm text-neutral-500 mt-0.5">
              {me?.hasPassword
                ? '已设置登录密码，可用邮箱+密码登录，作为微信/邮箱丢失时的兜底'
                : '尚未设置登录密码，绑定邮箱后可用邮箱+密码登录'}
            </p>
          </div>
          <button
            onClick={() => setShowPwd((v) => !v)}
            className="px-4 py-2 border border-brand-600 text-brand-600 rounded-lg text-sm font-medium hover:bg-brand-50"
          >
            {showPwd ? '取消' : me?.hasPassword ? '修改密码' : '设置密码'}
          </button>
        </div>
        {showPwd && (
          <form onSubmit={handleSetPassword} className="mt-3 space-y-3">
            <input
              type="password"
              required
              placeholder={me?.hasPassword ? '输入新密码' : '新密码'}
              className="w-full px-3 py-2 border rounded-lg"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
            />
            <button
              type="submit"
              disabled={pwdLoading}
              className="w-full py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {pwdLoading ? '保存中...' : me?.hasPassword ? '保存新密码' : '保存密码'}
            </button>
          </form>
        )}
      </section>

      <Link href="/" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-700 mt-2">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
        返回首页
      </Link>
    </div>
  );
}
