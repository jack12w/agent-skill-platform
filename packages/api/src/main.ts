import 'dotenv/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { RateLimitGuard } from './common/rate-limit.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  // ── 全局限流：每 IP 每分钟 120 次请求 ────
  // 可根据需要调整窗口大小和次数
  app.useGlobalGuards(new RateLimitGuard(60_000, 120));

  // ── Body Parser 限制 ─────────────────────
  app.use(json({ limit: '10mb' }));
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

  app.setGlobalPrefix('api');

  const port = parseInt(process.env.PORT || '3001', 10);
  await app.listen(port, '0.0.0.0'); // 监听所有网卡，适配 Docker/多网卡

  console.log(`🚀 API running on http://0.0.0.0:${port}/api (PID: ${process.pid})`);
}
bootstrap();
