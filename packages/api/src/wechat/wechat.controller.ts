import { Controller, Get, Query, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { WechatService } from './wechat.service';

@Controller('wechat')
export class WechatController {
  constructor(private wechatService: WechatService) {}

  /**
   * 公开接口：返回 JS-SDK 配置签名参数。
   * 仅返回 appId/timestamp/nonceStr/signature，绝不暴露 AppSecret 与 jsapi_ticket。
   */
  @Get('jssdk')
  getJssdk(@Query('url') url?: string, @Req() req?: Request) {
    if (!url) throw new BadRequestException('缺少 url 参数');
    // 允许域名 = 当前请求 Host + 配置的 PUBLIC_BASE_URL 主机名，任一匹配即可。
    // 这样即便 PUBLIC_BASE_URL 漏配/配错，只要请求来自本站域名就不会被误杀。
    const reqHost = req?.headers?.host?.split(':')[0] || '';
    const allowedHosts = [reqHost, this.wechatService.baseHost].filter(Boolean);
    return this.wechatService.getJssdkConfig(url, allowedHosts);
  }
}
