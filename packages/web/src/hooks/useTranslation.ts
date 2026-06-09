'use client';

import { useState, useCallback, useEffect } from 'react';
import zh from '../locales/zh';
import en from '../locales/en';

type Lang = 'zh' | 'en';
const locales = { zh, en };

let globalLang: Lang = 'zh';
const listeners = new Set<() => void>();

export function setGlobalLang(lang: Lang) {
  globalLang = lang;
  listeners.forEach((fn) => fn());
}

export function getGlobalLang(): Lang {
  return globalLang;
}

/** 获取初始语言：优先 cookie（跨页面始终最新），其次 window.__LANG__（仅首次加载时有效） */
function initLang(): Lang {
  if (typeof window !== 'undefined') {
    // 优先读取 cookie：每次切语言都会更新，软导航时也保持最新
    const match = document.cookie.match(/(?:^|;\s*)lang=([^;]*)/);
    const cookieLang = match?.[1];
    if (cookieLang === 'en' || cookieLang === 'zh') {
      globalLang = cookieLang;
      return cookieLang;
    }
    // 兜底：服务端注入的语言偏好（仅首次加载时有效，软导航后可能过期）
    const injected = (window as any).__LANG__;
    if (injected === 'en' || injected === 'zh') {
      globalLang = injected;
      return injected;
    }
  }
  return globalLang;
}

export default function useTranslation() {
  // SSR 阶段不读取 cookie/window，避免 hydrate mismatch
  const [lang, setLang] = useState<Lang>(globalLang);

  useEffect(() => {
    // 客户端初始化：从 cookie/window 读取真实语言偏好
    const realLang = initLang();
    if (realLang !== lang) setLang(realLang);

    const listener = () => setLang(globalLang);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    const keys = key.split('.');
    let val: any = locales[lang];
    for (const k of keys) {
      val = val?.[k];
    }
    if (typeof val !== 'string') return key;
    if (params) {
      return val.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
    }
    return val;
  }, [lang]);

  const toggleLang = useCallback(() => {
    const next = lang === 'zh' ? 'en' : 'zh';
    // 先写 cookie 确保导航时中间件能读到正确的语言偏好
    document.cookie = `lang=${next};path=/;max-age=${60 * 60 * 24 * 365}`;

    // 完整导航到对应语言 URL，触发中间件 + layout 重渲染
    // 确保 html lang 属性、window.__LANG__ 脚本、SSR 内容全部正确
    const currentPath = window.location.pathname;
    if (next === 'en' && !currentPath.startsWith('/en')) {
      window.location.href = `/en${currentPath === '/' ? '' : currentPath}${window.location.search}${window.location.hash}`;
    } else if (next === 'zh' && currentPath.startsWith('/en')) {
      const newPath = currentPath.replace(/^\/en/, '') || '/';
      window.location.href = `${newPath}${window.location.search}${window.location.hash}`;
    } else {
      // 当前已是对应语言路径，但可能 cookie 不一致，强制刷新
      window.location.reload();
    }
  }, [lang]);

  return { t, lang, toggleLang };
}
