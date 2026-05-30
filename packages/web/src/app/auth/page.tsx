'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useTranslation from '../../hooks/useTranslation';

export default function AuthPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', code: '' });
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleSendCode = async () => {
    if (!form.email) return;
    setSendingCode(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email }),
      });
      const data = await res.json();
      if (res.ok) {
        setCountdown(60);
        // 开发环境 SMTP 未配时，后端会直接返回验证码
        if (data.code) setForm(f => ({ ...f, code: data.code }));
      } else {
        alert(data.message || '发送失败，请重试');
      }
    } catch { alert('发送失败'); }
    finally { setSendingCode(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = tab === 'login'
        ? { email: form.email, password: form.password }
        : { email: form.email, password: form.password, name: form.name, code: form.code };
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      localStorage.setItem('token', data.access_token);
      localStorage.setItem('user', JSON.stringify(data.user));
      router.push('/dashboard');
    } catch (err: any) {
      alert((tab === 'login' ? t('auth.loginFailed') : t('auth.registerFailed')) + ': ' + (err.message || String(err)));
    } finally { setLoading(false); }
  };

  const handleWechatLogin = async () => {
    try {
      const res = await fetch('/api/auth/wechat/url');
      const { url } = await res.json();
      const w = 600, h = 700;
      const left = Math.max(0, (window.screen.availWidth - w) / 2);
      const top = Math.max(0, (window.screen.availHeight - h) / 2);
      const win = window.open(url, 'wechat_login', `width=${w},height=${h},left=${left},top=${top}`);
      if (!win) { alert('请允许弹窗以使用微信登录'); return; }
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'WECHAT_LOGIN') {
          localStorage.setItem('token', e.data.token);
          localStorage.setItem('user', JSON.stringify(e.data.user));
          router.push('/dashboard');
        }
      }, { once: true });
    } catch { alert('微信登录失败'); }
  };

  // 本地开发模拟微信登录
  const handleMockWechatLogin = async () => {
    try {
      const res = await fetch('/api/auth/wechat/mock-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: '测试用户' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      localStorage.setItem('token', data.access_token);
      localStorage.setItem('user', JSON.stringify(data.user));
      router.push('/dashboard');
    } catch { alert('模拟登录失败'); }
  };

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-16 sm:py-24">
      <h1 className="text-3xl font-bold text-center mb-8">{t('auth.title')}</h1>
      <div className="flex mb-6 p-1 bg-gray-100 rounded-lg">
        <button onClick={() => setTab('login')} className={`flex-1 py-2 rounded-md ${tab === 'login' ? 'bg-white shadow-sm' : ''}`}>{t('auth.login')}</button>
        <button onClick={() => setTab('register')} className={`flex-1 py-2 rounded-md ${tab === 'register' ? 'bg-white shadow-sm' : ''}`}>{t('auth.register')}</button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        {tab === 'register' && (
          <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.name')}</label>
            <input type="text" required className="w-full px-3 py-2 border rounded-lg" value={form.name} onChange={e => setForm({...form, name: e.target.value})} />
          </div>
        )}
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.email')}</label>
          <input type="email" required className="w-full px-3 py-2 border rounded-lg" value={form.email} onChange={e => setForm({...form, email: e.target.value})} />
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.password')}</label>
          <input type="password" required className="w-full px-3 py-2 border rounded-lg" value={form.password} onChange={e => setForm({...form, password: e.target.value})} />
        </div>
        {tab === 'register' && (
          <div className="flex gap-2">
            <input type="text" required maxLength={6} placeholder="验证码" className="flex-1 px-3 py-2 border rounded-lg" value={form.code} onChange={e => setForm({...form, code: e.target.value})} />
            <button type="button" onClick={handleSendCode} disabled={sendingCode || countdown > 0 || !form.email}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              {sendingCode ? '...' : countdown > 0 ? `${countdown}s` : '获取验证码'}
            </button>
          </div>
        )}
        <button type="submit" disabled={loading} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 disabled:bg-gray-400">
          {loading ? '...' : tab === 'login' ? t('auth.login') : t('auth.register')}
        </button>
      </form>

      {/* 微信登录（审核通过后将 NEXT_PUBLIC_WECHAT_LOGIN_ENABLED 改为 true 即可启用） */}
      {process.env.NEXT_PUBLIC_WECHAT_LOGIN_ENABLED === 'true' && (
        <div className="mt-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 border-t border-gray-200" />
            <span className="text-sm text-gray-400">或</span>
            <div className="flex-1 border-t border-gray-200" />
          </div>
          <button onClick={handleWechatLogin} className="w-full py-3 bg-green-500 text-white rounded-lg font-bold hover:bg-green-600 flex items-center justify-center gap-2">
            <svg className="w-5 h-5" viewBox="0 0 1024 1024" fill="currentColor">
              <path d="M669.3 369.4c9.8 0 19.6 0 29.4 1.6C671 245.2 536.9 152 383.2 152 211.6 152 71 269.7 71 416.8c0 85 45.8 156.9 124.2 210.9l-31.1 93.2L273.6 667c39.2 8.2 70.3 16.3 109.5 16.3 9.8 0 19.6 0 31.1-1.6-6.5-21.3-9.8-42.5-9.8-65.4 0.1-135.7 116.2-246.9 264.9-246.9z m-168.4-85c24.5 0 39.2 16.3 39.2 39.2 0 22.9-16.3 39.2-39.2 39.2-24.5 0-47.4-16.4-47.4-39.2 0-24.5 24.6-39.2 47.4-39.2z m-216.3 73.1c-24.7 0-47.8-16.2-47.8-38.8 0-24.3 24.7-38.8 47.8-38.8s39.5 16.2 39.5 38.8c0.1 22.7-16.4 38.8-39.5 38.8z"/>
              <path d="M953.8 613c0-125.9-124.2-227.2-264.8-227.2-148.8 0-266.5 103-266.5 227.2 0 125.9 117.7 227.2 266.5 227.2 31.1 0 62.1-8.2 93.2-16.3l85 47.4-22.9-78.5c62.1-47.4 109.5-109.5 109.5-179.8z m-351.5-39.2c-14.7 0-31.1-14.7-31.1-31.1 0-14.7 16.3-31.1 31.1-31.1 22.9 0 39.2 16.3 39.2 31.1 0 16.4-14.7 31.1-39.2 31.1z m178-7.6c-14.8 0-31.3-14.6-31.3-30.7 0-14.6 16.5-30.7 31.3-30.7 23.1 0 39.5 16.2 39.5 30.7 0 16.2-16.4 30.7-39.5 30.7z"/>
            </svg>
            微信登录
          </button>
          {typeof window !== 'undefined' && window.location.hostname === 'localhost' && (
            <button onClick={handleMockWechatLogin} className="w-full py-2 mt-2 border-2 border-dashed border-gray-300 text-gray-400 rounded-lg text-sm hover:border-green-400 hover:text-green-500">
              Dev 微信登录 (模拟)
            </button>
          )}
        </div>
      )}

      <p className="text-center text-sm text-gray-500 mt-4">
        {tab === 'login' ? (
          <button onClick={() => setTab('register')} className="text-blue-600">{t('auth.noAccount')}</button>
        ) : (
          <button onClick={() => setTab('login')} className="text-blue-600">{t('auth.hasAccount')}</button>
        )}
      </p>
    </div>
  );
}
