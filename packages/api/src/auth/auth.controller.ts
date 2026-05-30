import { Controller, Post, Patch, Get, Body, HttpCode, HttpStatus, UseGuards, UseInterceptors, UploadedFile, Request, Query, BadRequestException } from '@nestjs/common';
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

  // ── 微信登录 ─────────────────────────────
  @Get('wechat/url')
  getWechatUrl() {
    return this.authService.getWechatAuthUrl();
  }

  @Get('wechat/callback')
  async wechatCallback(@Query('code') code: string, @Query('state') state: string) {
    const result = await this.authService.wechatCallback(code, state);
    // 返回 HTML 页面通知父窗口登录成功
    const token = result.access_token;
    const user = JSON.stringify(result.user).replace(/</g, '\\u003c');
    return `
      <html><body><script>
        window.opener.postMessage({ type: 'WECHAT_LOGIN', token: '${token}', user: ${user} }, '*');
        window.close();
      </script></body></html>
    `;
  }

  // ── 本地开发模拟微信登录 ──────────────────
  @Post('wechat/mock-login')
  async mockWechatLogin(@Body() body: { nickname?: string }) {
    return this.authService.mockWechatLogin(body.nickname);
  }
}
