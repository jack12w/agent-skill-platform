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
 * 402 团队订阅墙（0047 / P4）：订阅墙生效时，团队名下 paid 技能须订阅团队才能下载。
 * 与 PAYMENT_REQUIRED 严格区分 —— 墙生效时团队技能不单卖，前端收到本 code
 * 必须弹团队订阅窗；团队从未开过套餐时按技能定价返回 PAYMENT_REQUIRED 走收银台。
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
