import { HttpException, HttpStatus } from '@nestjs/common';

/** 402 未付费：前端据此唤起收银台。response 携带定价信息。 */
export class PaymentRequiredException extends HttpException {
  constructor(pricing: any) {
    super(
      {
        code: 'PAYMENT_REQUIRED',
        message: '该技能需要付费后才能下载',
        pricing,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
