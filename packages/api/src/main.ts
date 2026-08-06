import 'dotenv/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { RateLimitGuard } from './common/rate-limit.guard';
import { CacheInterceptor } from './common/cache.interceptor';
import { SystemMetricsService } from './common/system-metrics.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ── Trust proxy（Docker/Nginx 反向代理后需信任 X-Forwarded-For） ──
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // ── 安全头（Helmet） ──────────────────────
  app.use(helmet());

  // ── 响应压缩（gzip/brotli） ───────────────
  // 大幅减少传输量，尤其对列表/排行榜等大响应有效
  app.use(compression());

  // ── CORS（生产环境限制域名） ──────────────
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') || '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    maxAge: 86400,
  });

  // ── 全局限流：每真实客户端 IP 每分钟 120 次（Redis 跨进程共享计数） ────
  // 守卫内部已做：① X-Forwarded-For 取真实客户端 IP；② 拿不到真实 IP（反代/网桥）时回退全局大桶（2000/min），
  //    避免所有用户共享小桶被打满；③ Redis 不可用时降级内存兜底，绝不阻塞全站；④ /api/health 豁免。
  app.useGlobalGuards(new RateLimitGuard(120));

  // ── 热点只读 GET 接口 Redis 响应缓存（扛 5000 在线的核心杠杆） ────
  // 仅白名单公开 GET（列表/详情/版本/榜单/分类/GEO feed）；匿名共享 + 登录用户按令牌隔离（防串号）；
  // Redis 不可用时直接放行不缓存。详见 cache.interceptor.ts。
  app.useGlobalInterceptors(new CacheInterceptor());

  // ── Body Parser 限制 ─────────────────────
  // verify 钩子缓存原始 body（req.rawBody），供微信支付回调验签使用（不修改既有 JSON 解析行为）
  app.use(json({ limit: '10mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  // ── 关闭 Express 指纹，减少攻击面 ─────────
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // ── 全局 API 不允许索引 ──────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  });

  // ── 全局超时中间件：每个请求最多 30s ──────
  app.use((_req, res: any, next: () => void) => {
    res.setTimeout(30_000, () => {
      if (!res.headersSent) {
        res.status(503).json({ message: 'Request timeout' });
      }
    });
    next();
  });

  // ── 请求计数中间件（用于系统监控 QPS）────
  // 仅统计 /api 路径且排除健康检查，避免污染指标
  const metrics = app.get(SystemMetricsService);
  app.use((req, _res, next) => {
    const url = (req.originalUrl || req.url || '') as string;
    if (url.startsWith('/api') && !url.includes('/api/health')) {
      metrics.recordRequest();
    }
    next();
  });

  app.setGlobalPrefix('api');

  const port = parseInt(process.env.PORT || '3001', 10);
  await app.listen(port, '0.0.0.0'); // 监听所有网卡，适配 Docker/多网卡

  console.log(`🚀 API running on http://0.0.0.0:${port}/api (PID: ${process.pid})`);
}
bootstrap();
