import { Injectable, UnauthorizedException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { VerificationCode } from './verification-code.entity';
import { Skill } from '../skills/skill.entity';
import { Comment } from '../skills/comment.entity';
import { OssService } from '../storage/oss.service';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

// In-memory CSRF state store for WeChat OAuth (5-min TTL, auto-cleanup)
const wechatStates = new Map<string, { expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of wechatStates) { if (v.expiresAt < now) wechatStates.delete(k); }
}, 600_000);

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(VerificationCode)
    private codeRepository: Repository<VerificationCode>,
    @InjectRepository(Skill)
    private skillRepository: Repository<Skill>,
    @InjectRepository(Comment)
    private commentRepository: Repository<Comment>,
    private jwtService: JwtService,
    private ossService: OssService,
  ) {}

  async register(email: string, pass: string, name: string, code?: string) {
    // 验证码必填，防止绕过邮箱验证直接注册
    if (!code) throw new BadRequestException('Verification code is required');
    await this.verifyCode(email, code);
    const salt = await bcrypt.genSalt();
    const password_hash = await bcrypt.hash(pass, salt);
    const user = this.userRepository.create({ email, password_hash, name });
    const saved = await this.userRepository.save(user);
    const payload = { sub: saved.id, email: saved.email };
    return {
      access_token: await this.jwtService.signAsync(payload),
      user: { id: saved.id, email: saved.email, name: saved.name, avatar_url: saved.avatar_url },
    };
  }

  async login(email: string, pass: string) {
    const user = await this.userRepository.findOne({
      where: { email },
      select: ['id', 'email', 'password_hash', 'name', 'avatar_url'],
    });
    if (user && (await bcrypt.compare(pass, user.password_hash))) {
      const payload = { sub: user.id, email: user.email };
      return {
        access_token: await this.jwtService.signAsync(payload),
        user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
      };
    }
    throw new UnauthorizedException();
  }

  async updateProfile(userId: string, data: { name?: string; avatar_url?: string }) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (data.name !== undefined) user.name = data.name;
    if (data.avatar_url !== undefined) user.avatar_url = data.avatar_url;
    await this.userRepository.save(user);
    return { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url };
  }

  async updateAvatar(userId: string, fileBuffer: Buffer, mimetype: string) {
    const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/jpeg' ? 'jpg' : 'png';
    const objectKey = `avatars/${userId}.${ext}`;
    const url = await this.ossService.putBuffer(objectKey, fileBuffer, mimetype);
    await this.userRepository.update(userId, { avatar_url: url });
    const user = await this.userRepository.findOne({ where: { id: userId } });
    return { id: user!.id, email: user!.email, name: user!.name, avatar_url: url };
  }

  // ── 邮箱验证码 ───────────────────────────
  async sendVerificationCode(email: string) {
    // 生成 6 位随机验证码
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 分钟有效

    await this.codeRepository.save({ email, code, used: false, expires_at });

    // 尝试通过 nodemailer 发送（如果没有配置，仅记录日志）
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.qq.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
      await transporter.sendMail({
        from: `"Skill Register" <${process.env.SMTP_USER || 'noreply@example.com'}>`,
        to: email,
        subject: 'SkillHub - 邮箱验证码',
        text: `您的验证码是：${code}，10 分钟内有效。`,
      });
    } catch (e: any) {
      // SMTP 未配置或发送失败
      console.error('[SMTP] 邮件发送失败:', e.message || e);
      // 开发环境：SMTP 没配时直接返回验证码，方便调试
      if (!process.env.SMTP_USER) {
        return { message: '验证码已生成（SMTP 未配置，验证码仅返回本次响应）', code, expires_in: 600 };
      }
    }
    return { message: '验证码已发送', expires_in: 600 };
  }

  private async verifyCode(email: string, code: string) {
    const record = await this.codeRepository.findOne({
      where: { email, code, used: false },
      order: { created_at: 'DESC' },
    });
    if (!record) throw new BadRequestException('验证码错误');
    if (new Date() > record.expires_at) throw new BadRequestException('验证码已过期');
    record.used = true;
    await this.codeRepository.save(record);
  }

  // ── 微信登录 ─────────────────────────────
  async getWechatAuthUrl() {
    const appId = process.env.WECHAT_APPID || 'wxb2537aa7600236a7';
    const redirectUri = encodeURIComponent(
      process.env.WECHAT_REDIRECT_URI || `${process.env.PUBLIC_BASE_URL}/api/auth/wechat/callback`
    );
    const state = crypto.randomBytes(16).toString('hex');
    // Store state in memory (5-min TTL) for CSRF protection
    wechatStates.set(state, { expiresAt: Date.now() + 5 * 60 * 1000 });
    return {
      url: `https://open.weixin.qq.com/connect/qrconnect?appid=${appId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`,
      state,
    };
  }

  async wechatCallback(code: string, state: string) {
    // Verify state to prevent CSRF attacks
    const stored = wechatStates.get(state);
    if (!stored || Date.now() > stored.expiresAt) {
      throw new BadRequestException('Invalid or expired state parameter');
    }
    wechatStates.delete(state);

    const appId = process.env.WECHAT_APPID || 'wxb2537aa7600236a7';
    const appSecret = process.env.WECHAT_APPSECRET;
    if (!appSecret) throw new BadRequestException('WeChat AppSecret not configured');
    // 1. 用 code 交换 access_token
    const tokenRes = await fetch(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${appSecret}&code=${code}&grant_type=authorization_code`
    );
    const tokenData = await tokenRes.json();
    if (tokenData.errcode) {
      throw new BadRequestException(`微信登录失败: ${tokenData.errmsg}`);
    }

    const { openid, unionid, access_token } = tokenData;

    // 2. 获取用户信息
    const userRes = await fetch(
      `https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}`
    );
    const wechatUser = await userRes.json();

    // 3. 查找或创建用户
    let user = await this.userRepository.findOne({
      where: { wechat_openid: openid },
      select: ['id', 'email', 'name', 'avatar_url', 'wechat_openid', 'wechat_unionid'],
    });
    if (!user) {
      user = this.userRepository.create({
        email: `wx_${openid.slice(0, 12)}@wechat.local`,
        password_hash: '',
        name: wechatUser.nickname || '微信用户',
        wechat_openid: openid,
        wechat_unionid: unionid || null,
      });
      await this.userRepository.save(user);
    }

    const payload = { sub: user.id, email: user.email };
    return {
      access_token: await this.jwtService.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
    };
  }

  // ── 本地开发：模拟微信登录 ───────────────
  async mockWechatLogin(nickname?: string) {
    const mockOpenId = 'dev_mock_openid_' + Date.now();
    const mockName = nickname || '微信用户(测试)';
    let user = await this.userRepository.findOne({
      where: { wechat_openid: mockOpenId },
      select: ['id', 'email', 'name', 'avatar_url', 'wechat_openid', 'wechat_unionid'],
    });
    if (!user) {
      user = this.userRepository.create({
        email: `wx_mock_${Date.now()}@wechat.local`,
        password_hash: '',
        name: mockName,
        wechat_openid: mockOpenId,
      });
      await this.userRepository.save(user);
    }
    const payload = { sub: user.id, email: user.email };
    return {
      access_token: await this.jwtService.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
    };
  }

  // ── 未读评论通知 ────────────────────────
  async getUnreadComments(userId: string, since?: string) {
    const qb = this.commentRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'user')
      .leftJoinAndSelect('c.skill', 'skill')
      .where('skill.owner_user_id = :userId', { userId })
      .andWhere('c.user_id != :userId', { userId });

    if (since) {
      qb.andWhere('c.created_at > :since', { since: new Date(since) });
    }

    const comments = await qb
      .orderBy('c.created_at', 'DESC')
      .take(20)
      .getMany();

    const count = await qb.getCount();

    const items = comments.map((c) => ({
      id: c.id,
      skill_name: (c.skill as any)?.name ?? 'Unknown',
      skill_slug: (c.skill as any)?.slug ?? c.skill_id,
      user_name: c.user?.name ?? 'Anonymous',
      user_avatar: c.user?.avatar_url ?? null,
      content: c.content.length > 80 ? c.content.slice(0, 80) + '...' : c.content,
      created_at: c.created_at,
    }));

    return { count, comments: items };
  }
}
