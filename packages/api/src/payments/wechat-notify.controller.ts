import { Controller, Post, Req, HttpCode } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { RefundService } from './refund.service';

/**
 * 微信异步回调。故意不挂 AuthGuard（微信无法带 Bearer）。
 * 验签在各自 handle* 内完成（铁律①），未配平台证书时一律拒绝。
 */
@Controller('pay')
export class WechatNotifyController {
  constructor(
    private readonly orders: OrdersService,
    private readonly refunds: RefundService,
  ) {}

  private extract(req: Request): { rawBody: string; headers: Record<string, string> } {
    const rawBody: string =
      (req as any).rawBody?.toString?.() ||
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v[0];
    }
    return { rawBody, headers };
  }

  /** 支付结果通知 */
  @Post('wechat/notify')
  @HttpCode(200)
  async notify(@Req() req: Request) {
    const { rawBody, headers } = this.extract(req);
    return this.orders.handleNotify(rawBody, headers);
  }

  /** 退款结果通知（REFUND.SUCCESS / REFUND.ABNORMAL / REFUND.CLOSED） */
  @Post('wechat/refund-notify')
  @HttpCode(200)
  async refundNotify(@Req() req: Request) {
    const { rawBody, headers } = this.extract(req);
    return this.refunds.handleRefundNotify(rawBody, headers);
  }
}
