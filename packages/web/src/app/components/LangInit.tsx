'use client';

import { setGlobalLang } from '../../hooks/useTranslation';

/**
 * 在 React 水合前（客户端）和 SSR 时（服务端）同步设置全局语言。
 *
 * - 服务端：组件体执行时立即调用 setGlobalLang(lang)，确保 SSR HTML 用正确语言
 * - 客户端：模块加载时读取 window.__LANG__（由 layout <script> 注入），早于 React 水合
 *
 * 两个阶段使用同样的 lang 值，消除 hydration mismatch。
 */

// 客户端：在 React 水合前读取服务端注入的语言偏好
if (typeof window !== 'undefined' && (window as any).__LANG__) {
  const injected = (window as any).__LANG__;
  if (injected === 'en' || injected === 'zh') {
    setGlobalLang(injected);
  }
}

export default function LangInit({ lang }: { lang: 'zh' | 'en' }) {
  // 服务端 SSR：React 渲染该组件时立即设置全局语言
  if (typeof window === 'undefined') {
    setGlobalLang(lang);
  }
  return null;
}
