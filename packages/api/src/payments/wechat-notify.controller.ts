import { Controller, Post, Req, HttpCode } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';

/**
 * 微信支付异步回调。故意不挂 AuthGuard（微信无法带 Bearer）。
 * 验签在 OrdersService.handleNotify 内完成（铁律①）。
 */
@Controller('pay')
export class WechatNotifyController {
  constructor(private readonly orders: OrdersService) {}

  @Post('wechat/notify')
  @HttpCode(200)
  async notify(@Req() req: Request) {
    const rawBody: string =
      (req as any).rawBody?.toString?.() ||
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v[0];
    }
    return this.orders.handleNotify(rawBody, headers);
  }
}
