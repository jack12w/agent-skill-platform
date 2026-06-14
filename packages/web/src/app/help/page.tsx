'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';

const MENU = [
  { key: 'quickstart' },
  { key: 'about' },
  { key: 'contact' },
  { key: 'feedback' },
];

export default function HelpCenterPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState('quickstart');
  const [fbName, setFbName] = useState('');
  const [fbEmail, setFbEmail] = useState('');
  const [fbType, setFbType] = useState('suggestion');
  const [fbContent, setFbContent] = useState('');
  const [fbSent, setFbSent] = useState(false);
  const [fbSending, setFbSending] = useState(false);

  useEffect(() => {
    const hash = window.location.hash?.replace('#', '');
    if (hash && MENU.some(m => m.key === hash)) setActive(hash);
    try {
      const token = localStorage.getItem('token');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.email) setFbEmail(payload.email);
        if (payload.name) setFbName(payload.name);
      }
    } catch {}
  }, []);

  const switchTab = (key: string) => {
    setActive(key);
    window.location.hash = key;
  };

  const submitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fbName.trim() || !fbContent.trim()) return;
    const token = localStorage.getItem('token');
    if (!token) { window.location.href = '/auth'; return; }
    setFbSending(true);
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: fbName.trim(), email: fbEmail.trim(), content: fbContent.trim(), type: fbType }),
      });
      const j = await r.json();
      if (j.ok) { setFbSent(true); setFbName(''); setFbEmail(''); setFbContent(''); }
    } catch {} finally { setFbSending(false); }
  };

  const menuLabels: Record<string, string> = {
    quickstart: t('help.quickstart'),
    about: t('help.about'),
    contact: t('help.contact'),
    feedback: t('help.feedback'),
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex gap-0 min-h-[500px] border border-neutral-200 rounded-xl overflow-hidden bg-white">
        <aside className="w-48 sm:w-56 shrink-0 bg-neutral-100 border-r border-neutral-200">
          <div className="px-4 py-5 border-b border-neutral-200">
            <h2 className="text-sm font-semibold text-neutral-900">{t('help.title')}</h2>
          </div>
          <nav className="py-2">
            {MENU.map(m => (
              <button
                key={m.key}
                type="button"
                onClick={() => switchTab(m.key)}
                className={`block w-full text-left px-4 py-2.5 text-sm transition-colors ${
                  active === m.key
                    ? 'bg-brand-50 text-brand-700 font-medium border-r-2 border-brand-600'
                    : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {menuLabels[m.key]}
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex-1 p-6 sm:p-8 overflow-y-auto">
          {active === 'quickstart' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">{t('help.qsTitle')}</h1>
              <p className="text-neutral-500 text-sm mb-6">{t('help.qsDesc')}</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.qsStep1')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">
                {t('help.qsStep1Desc').split('技能广场')[0]}<Link href="/skills" className="text-brand-600 hover:underline">技能广场</Link>{t('help.qsStep1Desc').split('技能广场')[1] || ''}
              </p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.qsStep2')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">{t('help.qsStep2Desc')}</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.qsStep3')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">
                {t('help.qsStep3Desc').split('SKILL.md')[0]}<code className="bg-neutral-100 px-1 rounded">SKILL.md</code>{t('help.qsStep3Desc').split('SKILL.md')[1] || ''}
              </p>
              <h3 className="text-base font-semibold mt-4 mb-1">{t('help.qsStep3Md')}</h3>
              <pre className="bg-neutral-100 p-3 rounded text-xs text-neutral-700 overflow-x-auto">{`---
name: my-skill
version: 1.0.0
description: 技能描述
tags: [搜索, 数据分析]
---

# My Skill

(技能指令或说明内容)`}</pre>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.qsStep4')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">{t('help.qsStep4Desc')}</p>
            </div>
          )}

          {active === 'about' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">{t('help.aboutTitle')}</h1>
              <p className="text-neutral-500 text-sm mb-6">{t('help.aboutDesc')}</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.aboutPlatform')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">{t('help.aboutPlatformDesc')}</p>
              <p className="text-neutral-600 text-sm leading-relaxed mt-3">{t('help.aboutPlatformDesc2')}</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.aboutStudio')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">
                {t('help.aboutStudioDesc').split('星火工作室')[0]}
                <a href="https://rehomi.com/xinghuo" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline mx-1">星火工作室</a>
                {t('help.aboutStudioDesc').split('星火工作室')[1] || ''}
              </p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.aboutOpenSource')}</h2>
              <p className="text-neutral-600 text-sm leading-relaxed">
                {t('help.aboutOpenSourceDesc').split('开源项目')[0]}开源项目{t('help.aboutOpenSourceDesc').split('开源项目')[1]?.replace('欢迎贡献代码或提交 Issue。', '') || ''}
                <a href="https://github.com/jack12w/agent-skill-platform" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline mx-1">GitHub</a>
                。欢迎贡献代码或提交 Issue。
              </p>
            </div>
          )}

          {active === 'contact' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">{t('help.contactTitle')}</h1>
              <p className="text-neutral-500 text-sm mb-6">{t('help.contactDesc')}</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">{t('help.contact')}</h2>
              <div className="space-y-3 text-sm text-neutral-600">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-400 w-16 shrink-0">{t('help.contactEmail')}</span>
                  <a href="mailto:287083583@qq.com" className="text-brand-600 hover:underline">287083583@qq.com</a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-neutral-400 w-16 shrink-0">{t('help.contactGithub')}</span>
                  <a href="https://github.com/jack12w/agent-skill-platform/issues" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">提交 Issue</a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-neutral-400 w-16 shrink-0">{t('help.contactWebsite')}</span>
                  <a href="https://rehomi.com/xinghuo" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">星火工作室</a>
                </div>
              </div>
            </div>
          )}

          {active === 'feedback' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">{t('help.fbTitle')}</h1>
              <p className="text-neutral-500 text-sm mb-4">{t('help.fbDesc')}</p>

              {typeof window !== 'undefined' && !localStorage.getItem('token') ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-700">
                  {t('help.fbLoginHint').split('登录')[0]}<a href="/auth" className="text-brand-600 hover:underline font-medium">登录</a>{t('help.fbLoginHint').split('登录')[1] || ''}
                </div>
              ) : fbSent ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                  {t('help.fbThanks')}
                </div>
              ) : (
                <form onSubmit={submitFeedback} className="space-y-4 max-w-lg">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">{t('help.fbName')} *</label>
                    <input type="text" required value={fbName} onChange={e => setFbName(e.target.value)} className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-brand-400" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">{t('help.fbEmail')}</label>
                    <input type="email" value={fbEmail} onChange={e => setFbEmail(e.target.value)} className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-brand-400" placeholder="your@email.com" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-2">{t('help.fbType')}</label>
                    <div className="flex gap-3">
                      {[
                        { key: 'suggestion', icon: '💡', label: t('help.fbSuggestion') },
                        { key: 'bug', icon: '🐛', label: t('help.fbBug') },
                        { key: 'other', icon: '💬', label: t('help.fbOther') },
                      ].map(opt => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setFbType(opt.key)}
                          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                            fbType === opt.key
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300'
                          }`}
                        >
                          <span>{opt.icon}</span>
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">{t('help.fbContent')} *</label>
                    <textarea required value={fbContent} onChange={e => setFbContent(e.target.value)} rows={5} className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-brand-400 resize-y" placeholder={t('help.fbPlaceholder')} />
                  </div>
                  <button type="submit" disabled={fbSending} className="px-6 py-2.5 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:bg-neutral-400">
                    {fbSending ? t('help.fbSubmitting') : t('help.fbSubmit')}
                  </button>
                </form>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
