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
    return this.authService.register(body.email, body.password, body.name, body.code);
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

  @Get('wechat/callback')
  async wechatCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const base = process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com';
    try {
      const result = await this.authService.wechatCallback(code, state);
      const params = new URLSearchParams({
        token: result.access_token,
        user: JSON.stringify(result.user),
      });
      return res.redirect(`${base}/auth/wechat-callback?${params.toString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '微信登录失败';
      return res.redirect(`${base}/auth/wechat-callback?error=${encodeURIComponent(message)}`);
    }
  }

  @UseGuards(AuthGuard)
  @Get('unread-comments')
  getUnreadComments(@Request() req: any, @Query('since') since?: string) {
    return this.authService.getUnreadComments(req.user.sub, since);
  }

  // ── 本地开发模拟微信登录 ──────────────────
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
