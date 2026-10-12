import { Controller, Post, Patch, Get, Body, HttpCode, HttpStatus, UseGuards, UseInterceptors, UploadedFile, Request, Query, BadRequestException, Res } from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() body: any) {
    // referral_code：邀请归因（迁移 0034）。注册时绑定一次终身不变；码无效静默忽略不挡注册。
    return this.authService.register(body.email, body.password, body.name, body.code, body.referral_code);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() body: any) {
    return this.authService.login(body.email, body.password);
  }

  @UseGuards(AuthGuard)
  @Patch('me')
  updateProfile(@Request() req: any, @Body() body: { name?: string; avatar_url?: string }) {
    return this.authService.updateProfile(req.user.sub, body);
  }

  @UseGuards(AuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.authService.getMe(req.user.sub);
  }

  // ── 邀请推广（迁移 0034）──────────────────
  // 路由放 /auth 下（复用 auth 模块的 User 仓库），不另开 users 模块接线。
  @UseGuards(AuthGuard)
  @Get('me/referral')
  getMyReferral(@Request() req: any) {
    return this.authService.getMyReferral(req.user.sub);
  }

  @UseGuards(AuthGuard)
  @Post('referral/claim')
  @HttpCode(HttpStatus.OK)
  claimReferral(@Request() req: any, @Body() body: { referral_code?: string }) {
    return this.authService.claimReferral(req.user.sub, body?.referral_code);
  }

  @UseGuards(AuthGuard)
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadAvatar(@Request() req: any, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException('Only PNG, JPEG, and WebP images are allowed');
    }
    return this.authService.updateAvatar(req.user.sub, file.buffer, file.mimetype);
  }

  // ── 邮箱验证码 ───────────────────────────
  @Post('send-code')
  sendCode(@Body() body: { email: string }) {
    return this.authService.sendVerificationCode(body.email);
  }

  // ── 忘记密码 ───────────────────────────
  @Post('reset-password')
  resetPassword(@Body() body: { email: string; code: string; newPassword: string }) {
    return this.authService.resetPassword(body.email, body.code, body.newPassword);
  }

  // ── 微信登录 ─────────────────────────────
  @Get('wechat/url')
  getWechatUrl() {
    return this.authService.getWechatAuthUrl();
  }

  // PC 网站应用扫码登录回调（微信 redirect 至此，弹窗内加载）。
  //
  // 2026-10-12：与微信内静默登录（mp-callback）统一为「Set-Cookie + 302 到干净 URL」。
  // 旧实现把 JWT 拼进查询串（`/auth/wechat-callback?token=...&user=...`），会被
  // 网关/Nginx 访问日志、浏览器历史、以及后续子资源请求的 Referer 持久落盘 —— 令牌
  // 泄露面远大于用户侧可见的地址栏。Cookie 下发后落地页从 cookie 读，URL 保持干净。
  // 注意：cookie 不带 httpOnly（与 mp-callback 一致），前端登录态统一读 localStorage，
  //       需要 JS 能读到；同源 + SameSite=Lax，扫码是弹窗内的顶层导航，不受限制。
  @Get('wechat/callback')
  async wechatCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const base = process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com';
    try {
      const result = await this.authService.wechatCallback(code, state);
      const maxAge = 7 * 24 * 3600 * 1000;
      res.cookie('token', result.access_token, { path: '/', sameSite: 'lax', maxAge });
      // ⚠️ 传**原始 JSON 字符串**，不要自己 encodeURIComponent —— express 的
      //    res.cookie 默认就会 encodeURIComponent，预先编码会二次编码
      //    （`%7B` → `%257B`），前端 decode 一次仍不是合法 JSON，账号对象丢失。
      //    前端约定：cookie 值 = encodeURIComponent(JSON)，读取端用 decodeCookieJson。
      res.cookie('user', JSON.stringify(result.user), {
        path: '/',
        sameSite: 'lax',
        maxAge,
      });
      return res.redirect(`${base}/auth/wechat-callback`);
    } catch (err) {
      // 错误信息不含凭证，留在查询串便于落地页展示按原因提示，无需走 cookie。
      const message = err instanceof Error ? err.message : '微信登录失败';
      return res.redirect(`${base}/auth/wechat-callback?error=${encodeURIComponent(message)}`);
    }
  }

  @UseGuards(AuthGuard)
  @Get('unread-comments')
  getUnreadComments(@Request() req: any, @Query('since') since?: string) {
    return this.authService.getUnreadComments(req.user.sub, since);
  }

  // ── 微信内网页授权静默登录（snsapi_base） ──
  // 前端「操作触发登录」在微信环境下跳转至此，302 到微信授权页；授权后微信回调 mp-callback。
  @Get('wechat/mp/url')
  async getWechatMpUrl(@Query('redirect') redirect: string, @Res() res: Response) {
    const { url } = await this.authService.getWechatMpAuthUrl(redirect);
    return res.redirect(url);
  }

  // 微信授权回调：用 code 换 openid → 查/建用户 → Set-Cookie 下发 token/user + 302 跳目标页。
  // 与 PC 扫码登录（wechat/callback）同规：服务端同域闭环，token 不进 URL。
  @Get('wechat/mp-callback')
  async wechatMpCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('rd') rd: string,
    @Res() res: Response,
  ) {
    const base = process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com';
    try {
      const result = await this.authService.wechatMpLogin(code, state, rd);
      // snsapi_base 拿不到 unionid（官方：仅 snsapi_userinfo 返回）；新用户升级授权一次以归并 PC 账号
      if ('needUserinfoAuth' in result) {
        const { url } = await this.authService.getWechatMpAuthUrl(result.redirect, 'snsapi_userinfo');
        return res.redirect(url);
      }
      // 成功：用 Http Cookie 携带 token/user（同源可读），并 302 跳目标页。
      // 关键修复：微信内置浏览器（尤其 Android X5 内核）在 OAuth 回调页用 JS 执行
      // window.location.href 跳转 SPA 路由时经常不触发导航，导致卡在 mp-callback 白屏。
      // 服务端 302 重定向在微信里 100% 可靠，不再依赖客户端 location.href。
      // 前端 AuthProvider 会在渲染期把 Cookie 同步回 localStorage（前端统一读 localStorage）。
      const safeRedirect = result.redirect && result.redirect.startsWith('/') ? result.redirect : '/';
      const maxAge = 7 * 24 * 3600 * 1000;
      res.cookie('token', result.access_token, { path: '/', sameSite: 'lax', maxAge });
      // ⚠️ 传原始 JSON（同 wechat/callback）：express 默认 encodeURIComponent，
      //    此处再手工编码会二次编码，前端 decode 一次后 JSON.parse 失败 →
      //    localStorage.user 变成 `%7B...` 字符串，getUserId() 恒为 null。
      res.cookie('user', JSON.stringify(result.user), {
        path: '/',
        sameSite: 'lax',
        maxAge,
      });
      return res.redirect(safeRedirect);
    } catch (err) {
      const message = err instanceof Error ? err.message : '微信登录失败';
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>登录失败</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>alert(${JSON.stringify(message)});window.location.href=${JSON.stringify(base + '/')};</script></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  }

  // ── 本地开发模拟微信登录 ──────────────────
  // 生产环境由 AuthService.mockWechatLogin 直接抛 404（详见那里的说明）。
  @Post('wechat/mock-login')
  async mockWechatLogin(@Body() body: { nickname?: string }) {
    return this.authService.mockWechatLogin(body.nickname);
  }

  // ── 微信绑定（已登录会话发起，避免重复账号） ──
  @UseGuards(AuthGuard)
  @Get('wechat/bind-url')
  getWechatBindUrl(@Request() req: any) {
    return this.authService.getWechatBindUrl(req.user.sub);
  }

  // 微信绑定回调（微信 redirect 至此，公开）：完成绑定后重定向到前端页面通知父窗口刷新
  @Get('wechat/bind-callback')
  async wechatBindCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const base = process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com';
    try {
      await this.authService.completeWechatBind(code, state);
      return res.redirect(`${base}/auth/wechat-bind-callback`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '微信绑定失败';
      return res.redirect(`${base}/auth/wechat-bind-callback?error=${encodeURIComponent(message)}`);
    }
  }

  // ── 绑定邮箱（已登录会话发起；邮箱已属他人时自动合并账号） ──
  @UseGuards(AuthGuard)
  @Post('bind-email')
  bindEmail(@Request() req: any, @Body() body: { email: string; code: string; password?: string }) {
    return this.authService.bindEmail(req.user.sub, body.email, body.code, body.password);
  }

  @UseGuards(AuthGuard)
  @Post('set-password')
  setPassword(@Request() req: any, @Body() body: { newPassword: string }) {
    return this.authService.setPassword(req.user.sub, body.newPassword);
  }
}
