import {
  Controller,
  Get,
  Post,
  HttpCode,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Public } from '../auth/public.decorator';
import { PluginsService } from './plugins.service';
import { PluginsAuthService } from './plugins-auth.service';

/**
 * 插件市场接口。
 *
 * 公开：列表 / 详情 / 设备授权（start、poll）/ 权益校验（entitlement）。
 * 需登录：我的订阅 / 授权页（pending、approve）/ 设备管理 / 下单 / 下载 / 取消。
 *
 * 凭证模型：插件不持有用户会话，只持有平台签发的**设备令牌**（见 PluginsAuthService）。
 * 因此插件侧调用的三个接口都是 @Public()，与用户 JWT 完全解耦 —— 这既避免了把
 * 7 天有效的账号凭证塞进插件，也让令牌权限天然收窄到「只能问权益」。
 *
 * 路由顺序：字面量路径（auth/*、entitlement、mine）必须声明在 :id/... 之前。
 */
@Controller('plugins')
@UseGuards(AuthGuard)
export class PluginsController {
  constructor(
    private readonly svc: PluginsService,
    private readonly auth: PluginsAuthService,
  ) {}

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

  // ─────────────────── 插件客户端（公开，凭授权码 / 设备令牌） ───────────────────

  /**
   * 发起设备授权：插件带 deviceId 换 `{code, poll_secret, verify_url}`。
   * 之后插件展示授权码（或直接打开 verify_url），并携 code + poll_secret 轮询。
   */
  /**
   * ⚠️ 下面三个客户端接口**必须显式 `@HttpCode(200)`**，不能走 Nest 对 `@Post()` 的默认
   * `201 Created` —— 客户端契约（PLUGIN_CLIENT_INTEGRATION.md：「除网络层错误外**始终返回
   * HTTP 200**」）是按 200 写的，浏览器扩展侧的三个判断点都是 `status !== 200`。
   *
   * 2026-09-26 生产事故：默认 201 同时打断了整条链路 —— ①发起授权被判为「连接授权服务器
   * 失败」②轮询永远拿不到结果（表现为卡在待授权）③权益永远返回「不确定」。而离线测试桩
   * 返回的是 200，所以全部测试仍绿 —— **桩与真实服务端契约不一致**是本次漏测的根因。
   * 改这三个装饰器前请先同步扩展侧与 PLUGIN_CLIENT_INTEGRATION.md。
   */
  @Public()
  @HttpCode(200)
  @Post('auth/start')
  start(
    @Body()
    body: {
      pluginSlug?: string;
      deviceId?: string;
      deviceName?: string;
      platform?: string;
    },
  ) {
    return this.auth.start({
      pluginSlug: body?.pluginSlug || '',
      deviceId: body?.deviceId || '',
      deviceName: body?.deviceName,
      platform: body?.platform,
    });
  }

  /** 轮询授权结果。必须同时给 code 与 poll_secret（光猜中授权码拿不到令牌）。 */
  @Public()
  @HttpCode(200)
  @Post('auth/poll')
  poll(@Body('code') code: string, @Body('poll_secret') pollSecret: string) {
    return this.auth.poll(code, pollSecret);
  }

  /** 权益校验：插件每次启动/临近到期调用，返回 valid 与 expires_at。 */
  @Public()
  @HttpCode(200)
  @Post('entitlement')
  entitlement(
    @Body('device_token') deviceToken: string,
    @Body('device_id') deviceId: string,
  ) {
    return this.auth.entitlement(deviceToken, deviceId);
  }

  // ─────────────────── 网页授权页（需登录） ───────────────────

  /** 授权页读取请求详情：哪个插件、已授权几台、当前账号是否已订阅 */
  @Get('auth/pending')
  pending(@Req() req: Request, @Query('code') code: string) {
    return this.auth.pending(this.uid(req), code);
  }

  /** 确认 / 拒绝授权。设备上限校验在此处进行。 */
  @Post('auth/approve')
  approve(
    @Req() req: Request,
    @Body('code') code: string,
    @Body('action') action?: 'approve' | 'deny',
  ) {
    return this.auth.approve(this.uid(req), code, action === 'deny' ? 'deny' : 'approve');
  }

  // ─────────────────── 我的订阅 / 设备管理 ───────────────────

  @Get('mine')
  mine(@Req() req: Request) {
    return this.svc.mySubscriptions(this.uid(req));
  }

  /** 已授权设备列表（账户页展示 + 逐台吊销） */
  @Get(':id/devices')
  devices(@Req() req: Request, @Param('id') id: string) {
    return this.auth.listDevices(this.uid(req), id);
  }

  @Delete(':id/devices/:deviceId')
  revokeDevice(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
  ) {
    return this.auth.revokeDevice(this.uid(req), id, deviceId);
  }

  /**
   * 设备改名。改过名后打上 name_custom 标记，之后重新授权 / 续费都不会再被
   * 客户端上报的名字覆盖（否则用户改的名字会被静默回滚）。
   * 已吊销的设备返回 404（列表里也看不到它，允许改等于开放盲写）。
   */
  @Patch(':id/devices/:deviceId')
  renameDevice(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Body('device_name') deviceName: string,
  ) {
    return this.auth.renameDevice(this.uid(req), id, deviceId, deviceName);
  }

  /** 全清：换机/重装前的粗粒度操作 */
  @Post(':id/reset-devices')
  resetDevices(@Req() req: Request, @Param('id') id: string) {
    return this.auth.revokeAllDevices(this.uid(req), id);
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
