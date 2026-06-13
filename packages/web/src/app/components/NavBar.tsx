'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import AvatarMenu from './AvatarMenu';
import NotificationBell from './NotificationBell';
import useTranslation from '../../hooks/useTranslation';

export default function NavBar() {
  const { t, lang, toggleLang } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showMobileSearch, setShowMobileSearch] = useState(false);

  const navLinks = [
    { href: '/skills', label: t('nav.skills'), blue: false },
    { href: '/leaderboard', label: t('nav.leaderboard'), blue: false },
    { href: '/submit', label: t('nav.submit'), blue: true },
  ];

  const langLabel = lang === 'zh' ? 'English' : '中文';

  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setIsAdmin(payload.role === 'admin');
      }
    } catch {}
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (q) {
      window.location.href = `/skills?query=${encodeURIComponent(q)}`;
      setShowMobileSearch(false);
    }
  };

  return (
    <nav className="flex items-center justify-between p-4 md:p-6 border-b gap-4">
      <Link href="/" className="flex items-center gap-2 shrink-0">
        <img src="/logo.svg" alt="SkillHub" className="h-8 md:h-9 w-auto" />
      </Link>

      {/* 桌面端：搜索 + 导航 + 语言 + 头像 */}
      <div className="hidden md:flex items-center gap-4">
        <form onSubmit={handleSearch} className="w-48">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('nav.search')} className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-full bg-gray-50 focus:bg-white focus:border-blue-400 focus:outline-none" />
            <button type="submit" className="hidden" />
          </div>
        </form>
        {navLinks.map((link) => (
          <Link key={link.href} href={link.href} className={`text-sm font-medium ${link.blue ? 'text-blue-600 hover:text-blue-800' : 'hover:text-blue-500'}`}>{link.label}</Link>
        ))}
        {isAdmin && (
          <Link href="/hub" title={t('admin.hub')} className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>
        )}
        <div className="flex items-center gap-1 text-sm text-gray-600 cursor-pointer hover:text-gray-900" onClick={toggleLang}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span>{langLabel}</span>
          <svg className="w-3 h-3 ml-0.5" viewBox="0 0 1024 1024" fill="currentColor"><path d="M543.962 746.182l384.163-401.629c17.681-18.504 17.68-48.475 0-66.947s-46.361-18.474-64.043 0L511.953 645.8l-352.155-368.194c-17.68-18.474-46.331-18.474-64.012 0s-17.682 48.444 0 66.947L479.949 746.182c17.652 18.504 46.331 18.504 64.012 0z"/></svg>
        </div>
        <NotificationBell />
        <AvatarMenu />
      </div>

      {/* 移动端：搜索图标 + 铃铛 + 头像 + 汉堡 */}
      <div className="flex md:hidden items-center gap-2 ml-auto">
        <button onClick={() => setShowMobileSearch(!showMobileSearch)} className="p-2 text-gray-500 hover:text-gray-700" aria-label="Search">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <NotificationBell />
        <AvatarMenu />
        <button onClick={() => setMenuOpen(!menuOpen)} className="p-2 -mr-2 text-gray-600 hover:text-gray-900" aria-label="Menu">
          {menuOpen ? (
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          ) : (
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          )}
        </button>
      </div>

      {/* 移动端搜索栏（点击展开） */}
      {showMobileSearch && (
        <div className="absolute top-16 left-0 right-0 bg-white border-b shadow-lg md:hidden z-50 p-4">
          <form onSubmit={handleSearch}>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('nav.search')} className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:border-blue-400 focus:outline-none" autoFocus />
              <button type="submit" className="hidden" />
            </div>
          </form>
        </div>
      )}

      {/* 移动端下拉菜单 */}
      {menuOpen && (
        <div className="absolute top-16 left-0 right-0 bg-white border-b shadow-lg md:hidden z-50">
          <div className="flex flex-col p-4 space-y-3">
            {navLinks.map((link) => (
              <Link key={link.href} href={link.href} onClick={() => setMenuOpen(false)}
                className={`text-base font-medium py-2 ${link.blue ? 'text-blue-600' : 'hover:text-blue-500'}`}
              >
                {link.label}
              </Link>
            ))}
            <hr className="border-gray-100" />
            {isAdmin && (
              <Link href="/hub" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 text-base font-medium py-2 text-gray-600 hover:text-blue-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t('admin.hub')}
              </Link>
            )}
            <button onClick={() => { toggleLang(); setMenuOpen(false); }}
              className="flex items-center gap-2 text-base font-medium py-2 text-gray-600 hover:text-gray-900 w-full text-left"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              {langLabel}
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
