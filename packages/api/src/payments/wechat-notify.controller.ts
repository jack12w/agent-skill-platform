import { Controller, Post, Req, HttpCode, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { RefundService } from './refund.service';
import { AdminPaymentsService } from './admin-payments.service';
import { WechatPayService } from './wechat-pay.service';

/**
 * 微信异步回调。故意不挂 AuthGuard（微信无法带 Bearer）。
 * 验签在各自 handle* 内完成（铁律①），未配平台证书时一律拒绝。
 */
@Controller('pay')
export class WechatNotifyController {
  constructor(
    private readonly orders: OrdersService,
    private readonly refunds: RefundService,
    private readonly adminPayments: AdminPaymentsService,
    private readonly wechat: WechatPayService,
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

  /**
   * 商家转账结果通知（提现打款终态：SUCCESS / FAIL / CANCELLED）。
   * 地址随转账单创建时的 notify_url 携带，无需商户后台配置。
   */
  @Post('wechat/transfer-notify')
  @HttpCode(200)
  async transferNotify(@Req() req: Request) {
    const { rawBody, headers } = this.extract(req);
    const sig = headers['wechatpay-signature'];
    const ts = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    if (!this.wechat.verifySignature(ts, nonce, rawBody, sig)) {
      throw new BadRequestException('签名验证失败');
    }
    const payload = JSON.parse(rawBody);
    const decrypted = this.wechat.decryptResource(payload.resource);
    await this.adminPayments.handleTransferNotify(decrypted);
    return { code: 'SUCCESS' };
  }
}
