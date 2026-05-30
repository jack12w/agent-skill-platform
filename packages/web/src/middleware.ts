import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SUPPORTED_LANGS = ['zh', 'en'] as const;
const DEFAULT_LANG = 'zh';

/**
 * 双语路由中间件
 *
 * 策略：
 *  - /en/xxx   → 改写为 /xxx 并附 cookie lang=en
 *  - /xxx      → 中文默认（不改写）
 *
 * 对用户透明：所有页面代码在同一个目录，通过 cookie 知道当前语言。
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const langCookie = req.cookies.get('lang')?.value;

  // 跳过静态资源 / API 请求
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // 如果访问 /en/... 路由，去掉前缀后改写，设 cookie 为 en
  if (pathname.startsWith('/en')) {
    const newPath = pathname.replace(/^\/en/, '') || '/';
    const res = NextResponse.rewrite(new URL(newPath, req.url));
    res.cookies.set('lang', 'en', { path: '/', maxAge: 60 * 60 * 24 * 365 });
    res.headers.set('x-lang', 'en');
    return res;
  }

  // 如果访问非 /en/ 但之前有 lang=en cookie，保留 cookie
  if (langCookie === 'en') {
    const res = NextResponse.next();
    res.headers.set('x-lang', 'en');
    return res;
  }

  // 中文路径：确保 cookie 为 zh
  const res = NextResponse.next();
  res.headers.set('x-lang', 'zh');
  if (langCookie !== 'zh') {
    res.cookies.set('lang', 'zh', { path: '/', maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
}

export const config = {
  matcher: [
    /*
     * 匹配所有路径，除了：
     * - _next/static（静态文件）
     * - _next/image（图片优化）
     * - favicon, robots, sitemap 等 SEO 文件
     * - API 路由
     */
    '/((?!_next/static|_next/image|favicon\\.svg|logo\\.svg|og-image\\.svg|robots\\.txt|llms\\.txt|sitemap\\.xml|\\.).*)',
  ],
};
