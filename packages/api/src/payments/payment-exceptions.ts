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

/**
 * 402 团队订阅墙（0047）：该团队已设置套餐，必须订阅团队才能下载名下技能。
 * 与 PAYMENT_REQUIRED 严格区分 —— 团队技能一律不单卖，前端收到本 code 时
 * 必须强制弹团队订阅窗，绝不进收银台（否则免费技能会触发「该技能无需付费」0 元死锁）。
 */
export class TeamSubscriptionRequiredException extends HttpException {
  constructor(team: any) {
    super(
      {
        code: 'TEAM_SUBSCRIPTION_REQUIRED',
        message: '订阅该团队后即可下载全部技能',
        team,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
