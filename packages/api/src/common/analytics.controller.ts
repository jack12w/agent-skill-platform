import { Controller, Post, Body, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PageView } from './page-view.entity';
import * as crypto from 'crypto';
import { Request } from 'express';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    @InjectRepository(PageView) private pvRepo: Repository<PageView>,
  ) {}

  @Post('pageview')
  async record(@Body() body: { path: string; referrer?: string }, @Req() req: Request) {
    if (body.path?.startsWith('/hub') || body.path?.startsWith('/api')) return { ok: true };
    // 优先取 X-Real-IP / X-Forwarded-For（Docker/Nginx 反向代理场景）
    const ip = (req.headers['x-real-ip'] as string)
      || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.ip
      || req.socket?.remoteAddress
      || 'unknown';
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 200);

    await this.pvRepo.save({
      path: body.path?.slice(0, 500) || '/',
      ip_hash: ipHash,
      user_agent: ua,
      referrer: body.referrer?.slice(0, 500) || null,
    });
    return { ok: true };
  }
}
