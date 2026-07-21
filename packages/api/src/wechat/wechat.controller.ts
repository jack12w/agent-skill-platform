import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { WechatService } from './wechat.service';

@Controller('wechat')
export class WechatController {
  constructor(private wechatService: WechatService) {}

  /**
   * 公开接口：返回 JS-SDK 配置签名参数。
   * 仅返回 appId/timestamp/nonceStr/signature，绝不暴露 AppSecret 与 jsapi_ticket。
   */
  @Get('jssdk')
  getJssdk(@Query('url') url?: string) {
    if (!url) throw new BadRequestException('缺少 url 参数');
    return this.wechatService.getJssdkConfig(url);
  }
}
