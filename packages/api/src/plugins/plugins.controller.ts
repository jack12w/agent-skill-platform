import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Public } from '../auth/public.decorator';
import { PluginsService } from './plugins.service';

/**
 * 插件市场接口。
 * 公开：列表 / 详情。
 * 需登录：我的订阅 / 订阅下单 / 下载（免费但需登录，防滥用与统计）/ 取消。
 * 付费闭环复用 PaymentsModule 的 OrdersService，order.type='plugin'，
 * 回调发货在 OrdersService.deliver 内按 type 分发，不在此处写支付逻辑。
 */
@Controller('plugins')
@UseGuards(AuthGuard)
export class PluginsController {
  constructor(private readonly svc: PluginsService) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  @Public()
  @Get()
  list() {
    return this.svc.list();
  }

  @Public()
  @Get('slug/:slug')
  bySlug(@Param('slug') slug: string) {
    return this.svc.getBySlug(slug);
  }

  /**
   * 卡密校验（插件客户端激活用）。公开、无 JWT。
   * body: { key: string } → { valid, plugin_slug?, expires_at? }
   */
  @Public()
  @Post('verify')
  verify(@Body('key') key: string) {
    if (!key || typeof key !== 'string') return { valid: false };
    return this.svc.verifyKey(key.trim());
  }

  @Get('mine')
  mine(@Req() req: Request) {
    return this.svc.mySubscriptions(this.uid(req));
  }

  @Post(':id/subscribe')
  subscribe(@Req() req: Request, @Param('id') id: string) {
    return this.svc.subscribe(this.uid(req), id);
  }

  @Get(':id/download')
  download(@Req() req: Request, @Param('id') id: string) {
    return this.svc.signDownload(id);
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string) {
    return this.svc.cancel(this.uid(req), id);
  }
}
