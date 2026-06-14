'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

const MENU = [
  { key: 'quickstart', label: '快速入门', en: 'Quick Start' },
  { key: 'about', label: '关于我们', en: 'About Us' },
  { key: 'contact', label: '联系我们', en: 'Contact Us' },
  { key: 'feedback', label: '反馈建议', en: 'Feedback' },
];

export default function HelpCenterPage() {
  const [active, setActive] = useState('quickstart');
  const [fbName, setFbName] = useState('');
  const [fbEmail, setFbEmail] = useState('');
  const [fbContent, setFbContent] = useState('');
  const [fbSent, setFbSent] = useState(false);
  const [fbSending, setFbSending] = useState(false);

  useEffect(() => {
    const hash = window.location.hash?.replace('#', '');
    if (hash && MENU.some(m => m.key === hash)) setActive(hash);
  }, []);

  const switchTab = (key: string) => {
    setActive(key);
    window.location.hash = key;
  };

  const submitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fbName.trim() || !fbContent.trim()) return;
    const t = localStorage.getItem('token');
    if (!t) { window.location.href = '/auth'; return; }
    setFbSending(true);
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ name: fbName.trim(), email: fbEmail.trim(), content: fbContent.trim() }),
      });
      const j = await r.json();
      if (j.ok) { setFbSent(true); setFbName(''); setFbEmail(''); setFbContent(''); }
    } catch {} finally { setFbSending(false); }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex gap-0 min-h-[500px] border border-gray-200 rounded-xl overflow-hidden bg-white">
        {/* Sidebar */}
        <aside className="w-48 sm:w-56 shrink-0 bg-gray-50 border-r border-gray-200">
          <div className="px-4 py-5 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-900">帮助中心</h2>
          </div>
          <nav className="py-2">
            {MENU.map(m => (
              <button
                key={m.key}
                type="button"
                onClick={() => switchTab(m.key)}
                className={`block w-full text-left px-4 py-2.5 text-sm transition-colors ${
                  active === m.key
                    ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {m.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 p-6 sm:p-8 overflow-y-auto">
          {active === 'quickstart' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">快速入门</h1>
              <p className="text-gray-500 text-sm mb-6">欢迎使用 SkillHub！本指南将帮助你快速上手。</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">1. 浏览技能</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                在 <Link href="/skills" className="text-blue-600 hover:underline">技能广场</Link> 中浏览按场景、角色、分类组织的 AI 技能。使用页面顶部的标签筛选功能快速定位你需要的技能类型。
              </p>

              <h2 className="text-lg font-semibold mt-6 mb-2">2. 下载使用</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                点击任意技能卡片进入详情页，查看技能的功能描述和使用说明。点击下载按钮获取 ZIP 技能包，导入到你的 AI 工作台（如 WorkBuddy、Accio Work 等）中即可使用。
              </p>

              <h2 className="text-lg font-semibold mt-6 mb-2">3. 提交技能</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                将你的 AI 技能打包为 ZIP 文件，确保包含 <code className="bg-gray-100 px-1 rounded">SKILL.md</code> 配置文件。在
                <Link href="/submit" className="text-blue-600 hover:underline">提交页面</Link> 上传并填写相关信息。提交后需等待管理员审核，审核通过后将在技能广场展示。
              </p>
              <h3 className="text-base font-semibold mt-4 mb-1">SKILL.md 格式</h3>
              <pre className="bg-gray-50 p-3 rounded text-xs text-gray-700 overflow-x-auto">{`---
name: my-skill
version: 1.0.0
description: 技能描述
tags: [搜索, 数据分析]
---

# My Skill

(技能指令或说明内容)`}</pre>

              <h2 className="text-lg font-semibold mt-6 mb-2">4. 创建团队</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                你可以创建团队，邀请成员加入，以团队身份发布和管理技能。在个人首页点击创建团队按钮即可开始。
              </p>
            </div>
          )}

          {active === 'about' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">关于我们</h1>
              <p className="text-gray-500 text-sm mb-6">SkillHub 是一个开放的 AI Agent 技能市场。</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">平台介绍</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                SkillHub 致力于构建 AI 时代的技能共享生态。开发者可以发布自己创建的 AI 技能包，用户可以浏览、下载和使用这些技能。我们相信开放的协作能让 AI 为每个人创造更多价值。
              </p>
              <p className="text-gray-600 text-sm leading-relaxed mt-3">
                平台支持多种 AI 工作台，包括 WorkBuddy、Accio Work、阿里国际站等场景。技能按角色（老板/管理/运营/业务/美工/市场/采购/供应链/社媒）和分类（选品洞察/Listing优化/广告投放等）组织，帮助用户精准找到需要的工具。
              </p>

              <h2 className="text-lg font-semibold mt-6 mb-2">星火工作室</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                SkillHub 由
                <a href="https://rehomi.com/xinghuo" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline mx-1">星火工作室</a>
                提供技术支持。我们专注于 AI 应用开发、技能生态建设和数字化解决方案。
              </p>

              <h2 className="text-lg font-semibold mt-6 mb-2">开源</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                SkillHub 是一个开源项目，源码托管在
                <a href="https://github.com/jack12w/agent-skill-platform" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline mx-1">GitHub</a>
                。欢迎贡献代码或提交 Issue。
              </p>
            </div>
          )}

          {active === 'contact' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">联系我们</h1>
              <p className="text-gray-500 text-sm mb-6">如有问题或合作需求，欢迎通过以下方式联系。</p>

              <h2 className="text-lg font-semibold mt-6 mb-2">联系方式</h2>
              <div className="space-y-3 text-sm text-gray-600">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 w-16 shrink-0">邮箱</span>
                  <a href="mailto:support@rehomi.com" className="text-blue-600 hover:underline">support@rehomi.com</a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 w-16 shrink-0">GitHub</span>
                  <a href="https://github.com/jack12w/agent-skill-platform/issues" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">提交 Issue</a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 w-16 shrink-0">网站</span>
                  <a href="https://rehomi.com/xinghuo" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">星火工作室</a>
                </div>
              </div>
            </div>
          )}

          {active === 'feedback' && (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-2xl font-bold mb-2">反馈建议</h1>
              <p className="text-gray-500 text-sm mb-4">我们非常重视你的意见，请在下方提交反馈或功能建议。</p>

              {typeof window !== 'undefined' && !localStorage.getItem('token') ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-700">
                  请先<a href="/auth" className="text-blue-600 hover:underline font-medium">登录</a>后再提交反馈。
                </div>
              ) : fbSent ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                  感谢你的反馈！我们会尽快处理。
                </div>
              ) : (
                <form onSubmit={submitFeedback} className="space-y-4 max-w-lg">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">姓名 *</label>
                    <input type="text" required value={fbName} onChange={e => setFbName(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400" placeholder="你的名字" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
                    <input type="email" value={fbEmail} onChange={e => setFbEmail(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400" placeholder="your@email.com" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">反馈内容 *</label>
                    <textarea required value={fbContent} onChange={e => setFbContent(e.target.value)} rows={5} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400 resize-y" placeholder="请描述你的建议或遇到的问题..." />
                  </div>
                  <button type="submit" disabled={fbSending} className="px-6 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:bg-gray-400">
                    {fbSending ? '提交中...' : '提交反馈'}
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
