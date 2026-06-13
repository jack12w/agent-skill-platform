import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import NavBar from './components/NavBar';
import AuthProvider from './components/AuthProvider';
import LangInit from './components/LangInit';
import AnalyticsTracker from './components/AnalyticsTracker';
import { WebSiteSchema, OrganizationSchema } from '../lib/structured-data';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL || 'https://skills.rehomi.com'),
  title: {
    default: 'SkillHub — AI Agent Skills Marketplace',
    template: '%s | SkillHub',
  },
  description:
    'Discover, share, and download AI Agent skills. The open marketplace for AI-powered tools, workflows, and automations. Built by developers, for the AI era.',
  keywords: [
    'AI agent',
    'AI skills',
    'AI tools',
    'agent marketplace',
    'AI workflow',
    'skill sharing',
    'AI automation',
    'SkillHub',
  ],
  authors: [{ name: 'SkillHub' }],
  creator: 'SkillHub',
  publisher: 'SkillHub',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    alternateLocale: 'en_US',
    url: BASE_URL,
    siteName: 'SkillHub',
    title: 'SkillHub — AI Agent Skills Marketplace',
    description:
      'Discover, share, and download AI Agent skills. The open marketplace for AI-powered tools, workflows, and automations.',
    images: [
      {
        url: '/og-image.svg',
        width: 1200,
        height: 630,
        alt: 'SkillHub',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SkillHub — AI Agent Skills Marketplace',
    description:
      'Discover, share, and download AI Agent skills. The open marketplace for AI tools.',
    images: ['/og-image.svg'],
    creator: '@skillhub',
  },
  alternates: {
    canonical: BASE_URL,
    languages: {
      'zh-CN': `${BASE_URL}`,
      'en-US': `${BASE_URL}/en`,
    },
  },
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
  verification: {
    // 预留搜索引擎验证
    // google: 'your-google-verification-code',
    // bing: 'your-bing-verification-code',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const headersList = headers();
  const lang = headersList.get('x-lang') === 'en' ? 'en' : 'zh-CN';
  const shortLang: 'zh' | 'en' = lang === 'en' ? 'en' : 'zh';

  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* 在 React 水合前注入语言偏好，确保 SSR 和客户端一致 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__LANG__=${JSON.stringify(shortLang)};`,
          }}
        />
      </head>
      <body className="font-sans">
        <LangInit lang={shortLang} />
        <AuthProvider>
          <AnalyticsTracker />
          <NavBar />
          <main className="min-h-screen">{children}</main>
          <footer className="p-6 sm:p-10 border-t text-center text-gray-500 text-sm space-y-1">
            <p>© 2026 SkillHub. Built for the AI era.</p>
            <p>
              技术支持：
              <a href="https://rehomi.com/xinghuo" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                星火工作室
              </a>
            </p>
          </footer>
        </AuthProvider>
        <WebSiteSchema />
        <OrganizationSchema />
      </body>
    </html>
  );
}
