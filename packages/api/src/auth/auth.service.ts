import { Injectable, UnauthorizedException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { User } from './user.entity';
import { VerificationCode } from './verification-code.entity';
import { Skill } from '../skills/skill.entity';
import { Comment } from '../skills/comment.entity';
import { Subscription } from '../subscriptions/subscription.entity';
import { Notification } from '../subscriptions/notification.entity';
import { OssService } from '../storage/oss.service';
import { MailQueueService } from '../common/mail-queue.service';
import { WechatStateStore } from './wechat-state.store';
import { DistributedStore } from '../common/dist-state.store';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

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
    private dataSource: DataSource,
    private mailQueue: MailQueueService,
  ) {}

  // ── 微信 OAuth 的 CSRF state ──
  // 存在 Redis 里（跨实例共享），进程内存仅作 Redis 不可用时的兜底。
  // 单容器时行为与原先一致；扩成多副本后仍能正确校验，不会大面积登录失败。
  private readonly wechatStates = new WechatStateStore<Record<string, never>>('wx:oauth:state');
  /** 绑定态额外记录发起绑定的 userId，回调据此把 openid 落到正确账号 */
  private readonly wechatBindStates = new WechatStateStore<{ userId: string }>('wx:bind:state');

  async register(email: string, pass: string, name: string, code?: string) {
    // 验证码必填，防止绕过邮箱验证直接注册
    if (!code) throw new BadRequestException('验证码必填');
    // 事务包裹：校验并消费验证码 + 创建用户。任一步失败整体回滚，
    // 验证码的 used=true 不会被误提交，用户可用同一验证码重试，避免「验证码错误」误报。
    return this.dataSource.transaction(async (manager) => {
      await this.verifyCode(email, code, manager);
      // 提前拦截重复注册：给出明确提示而非靠唯一约束抛 500，且不会烧掉验证码
      const existing = await manager.getRepository(User).findOne({ where: { email } });
      if (existing) throw new BadRequestException('该邮箱已注册，请直接登录');
      const salt = await bcrypt.genSalt();
      const password_hash = await bcrypt.hash(pass, salt);
      const user = manager.getRepository(User).create({ email, password_hash, name });
      const saved = await manager.getRepository(User).save(user);
      const payload = { sub: saved.id, email: saved.email, role: saved.role };
      return {
        access_token: await this.jwtService.signAsync(payload),
        user: { id: saved.id, email: saved.email, name: saved.name, avatar_url: saved.avatar_url },
      };
    });
  }

  async login(email: string, pass: string) {
    const user = await this.userRepository.findOne({
      where: { email },
      select: ['id', 'email', 'password_hash', 'name', 'avatar_url', 'role'],
    });
    if (user && (await bcrypt.compare(pass, user.password_hash))) {
      const payload = { sub: user.id, email: user.email, role: user.role };
      // 登录成功即记一笔当日活跃（兜底：登录请求本身不带 token，中间件不会触发）
      this.userRepository
        .query(
          `INSERT INTO user_daily_active (user_id, day) VALUES ($1, CURRENT_DATE)
           ON CONFLICT (user_id, day) DO NOTHING`,
          [user.id],
        )
        .catch(() => {});
      return {
        access_token: await this.jwtService.signAsync(payload),
        user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
      };
    }
    throw new UnauthorizedException();
  }

  async updateProfile(userId: string, data: { name?: string; avatar_url?: string; bio?: string; tags?: string[] }) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (data.name !== undefined) user.name = data.name;
    if (data.avatar_url !== undefined) user.avatar_url = data.avatar_url;
    if (data.bio !== undefined) user.bio = data.bio;
    if (data.tags !== undefined) user.tags = data.tags;
    await this.userRepository.save(user);
    return { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, bio: user.bio, tags: user.tags };
  }

  // 返回当前登录用户的完整资料（含 bio / tags），供前端挂载时同步 localStorage
  async getMe(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'email', 'name', 'avatar_url', 'bio', 'tags', 'role', 'email_verified', 'wechat_openid', 'wechat_openid_oa', 'wechat_openid_site', 'password_hash'],
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      tags: user.tags,
      role: user.role,
      wechatBound: !!(user.wechat_openid || user.wechat_openid_oa || user.wechat_openid_site),
      emailVerified: user.email_verified,
      hasPassword: !!user.password_hash,
    };
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
  // 应用层限流（原为进程内 static Map，多副本下每个副本各计一份 → 冷却/锁定力度被稀释 N 倍，
  // 6 位验证码的暴力枚举窗口随之放大 N 倍。已迁入 Redis 跨副本共享，进程内存仅作降级兜底）：
  //  - sendCooldown：同邮箱两次「获取验证码」最小间隔，防狂点打满 SMTP 连接池
  //  - verifyAttempts：同邮箱验证码错误累计次数，超限锁定一段时间，防暴力枚举 6 位码
  private readonly sendCooldown = new DistributedStore('auth:send:cd'); // email -> 下次允许发送的时间戳
  private readonly verifyAttempts = new DistributedStore('auth:verify:attempts'); // email -> 窗口内错误次数
  private static readonly SEND_COOLDOWN_MS = 60 * 1000; // 同邮箱 60s 冷却
  private static readonly MAX_VERIFY_ATTEMPTS = 5; // 窗口内最多 5 次错误
  private static readonly VERIFY_WINDOW_SEC = 10 * 60; // 计数窗口 10 分钟（固定窗口，非滑动）

  async sendVerificationCode(email: string) {
    const now = Date.now();
    // 同邮箱发送冷却：命中则直接拒绝，不落库、不发信（防狂点耗尽连接池）
    const nextAllowed = Number(await this.sendCooldown.get(email)) || 0;
    if (now < nextAllowed) {
      const wait = Math.ceil((nextAllowed - now) / 1000);
      throw new BadRequestException(`验证码发送过于频繁，请 ${wait} 秒后再试`);
    }
    // TTL 与冷却时长一致：到点自动失效，无需额外清理逻辑
    await this.sendCooldown.set(
      email,
      String(now + AuthService.SEND_COOLDOWN_MS),
      AuthService.SEND_COOLDOWN_MS / 1000,
    );

    // P2-1 数据卫生：惰性清理该邮箱已使用/已过期的旧验证码，避免 verification_codes 表无限膨胀。
    // 每次获取新码时触发，无需额外定时任务依赖；仅删 junk（保留本次即将写入的未用记录之外）。
    await this.codeRepository.delete({ email, used: true });
    await this.codeRepository
      .createQueryBuilder()
      .delete()
      .from(VerificationCode)
      .where('email = :email AND expires_at < :now', { email, now: new Date() })
      .execute();

    // 生成 6 位密码学安全随机验证码（crypto.randomInt 均匀分布，不可预测；
    // 旧实现 Math.random() 非密码学安全，理论上可被预测/枚举）
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 分钟有效

    await this.codeRepository.save({ email, code, used: false, expires_at });

    // 后台发送邮件，不阻塞 HTTP 响应：避免突发注册时请求被 SMTP 连接池排队阻塞
    // （曾导致「获取验证码」转圈约 40s）。用户立即收到「已发送」，邮件由后台投递。
    void this.sendOtpMail(email, code);

    // 仅非生产环境且未配置 SMTP 时，在响应中回吐明文码方便本地调试。
    // 生产环境绝不返回 code（防 P1-6 验证码/凭据泄露）。
    if (process.env.NODE_ENV !== 'production' && !process.env.SMTP_USER) {
      return { message: '验证码已生成（SMTP 未配置，验证码仅返回本次响应）', code, expires_in: 600 };
    }
    // 邮件为后台投递，无法即时确认送达：给中性提示，避免用户误判「码错」而反复重试（P1-2）
    return { message: '验证码已发送，若几分钟内未收到，请检查垃圾箱', expires_in: 600 };
  }

  /** 后台发送 OTP 邮件（不阻塞请求）：交给邮件队列异步投递，失败仅记录日志 */
  private sendOtpMail(email: string, code: string) {
    this.mailQueue.sendOtp(email, code);
  }

  // manager 可选：传入时复用调用方事务，保证「校验+消费+建用户」原子回滚
  private async verifyCode(email: string, code: string, manager?: EntityManager) {
    // 尝试次数限制（防暴力枚举 6 位码）：窗口内错误达上限则暂时锁定该邮箱
    // 计数跨副本共享，窗口随首次错误固定（不因后续错误续期，避免持续试探永远出不了窗口）
    const cnt = await this.verifyAttempts.getCount(email);
    if (cnt >= AuthService.MAX_VERIFY_ATTEMPTS) {
      throw new BadRequestException('验证码错误次数过多，请稍后重试');
    }
    const repo = manager ? manager.getRepository(VerificationCode) : this.codeRepository;
    const record = await repo.findOne({
      where: { email, code, used: false },
      order: { created_at: 'DESC' },
    });
    if (!record || new Date() > record.expires_at) {
      // 记一次失败（record 为空=码错，或已过期都计入，防枚举）
      await this.bumpVerifyAttempts(email);
      throw new BadRequestException(record ? '验证码已过期' : '验证码错误');
    }
    // 原子消费：仅当 used=false 时才置 true，并校验 affected 行数，
    // 并发场景下败者 update 命中 0 行 → 抛错，避免同一验证码被重复消费
    const result = await repo.update({ id: record.id, used: false }, { used: true });
    if (result.affected === 0) {
      await this.bumpVerifyAttempts(email);
      throw new BadRequestException('验证码错误');
    }
    // 校验成功：清零该邮箱失败计数。
    // 刻意**不 await**：此处正处在调用方（注册/重置密码）的 DB 事务内，且刚 UPDATE 过
    // 验证码行、持有行锁；等 Redis 回执（最坏 1s 超时）会白白拉长行锁持有时间。
    // 清零丢失可接受：计数本就有 10 分钟窗口，残留计数只会让用户下次多等，不影响安全。
    void this.verifyAttempts.reset(email).catch(() => {});
  }

  /** 累加某邮箱的验证码错误次数（固定窗口，用于暴力枚举防护） */
  private async bumpVerifyAttempts(email: string): Promise<void> {
    await this.verifyAttempts.incr(email, AuthService.VERIFY_WINDOW_SEC);
  }

  // ── 忘记密码 ───────────────────────────
  async resetPassword(email: string, code: string, newPassword: string) {
    if (!code) throw new BadRequestException('验证码不能为空');
    // 同样用事务包裹，保证验证码消费与密码更新原子：失败回滚，验证码可重试
    return this.dataSource.transaction(async (manager) => {
      await this.verifyCode(email, code, manager);
      const user = await manager.getRepository(User).findOne({ where: { email } });
      if (!user) throw new NotFoundException('该邮箱未注册');
      const salt = await bcrypt.genSalt();
      user.password_hash = await bcrypt.hash(newPassword, salt);
      await manager.getRepository(User).save(user);
      return { message: '密码已重置，请使用新密码登录' };
    });
  }

  // ── 微信登录 ─────────────────────────────
  // 微信登录总开关：关闭后所有微信链路（登录 / 绑定）在 API 层直接拒绝
  private assertWechatLoginEnabled() {
    if (process.env.WECHAT_LOGIN_ENABLED !== 'true') {
      throw new BadRequestException('微信登录未启用');
    }
  }

  async getWechatAuthUrl() {
    this.assertWechatLoginEnabled();
    const appId = process.env.WECHAT_APPID;
    // 网站应用(PC 扫码/绑定)与公众号是两套独立 AppID/OpenID 命名空间，
    // 绝不可静默回退到公众号 AppID，否则 openid 落错列 → 账号分裂。
    // 生产必须显式配置 WECHAT_APPID，缺失即禁用本路径而非带着错 AppID 跑。
    if (!appId) throw new BadRequestException('网站应用微信登录未配置（WECHAT_APPID）');
    const redirectUri = encodeURIComponent(
      process.env.WECHAT_REDIRECT_URI || `${process.env.PUBLIC_BASE_URL}/api/auth/wechat/callback`
    );
    const state = crypto.randomBytes(16).toString('hex');
    // 存入 Redis（5 分钟 TTL），回调时原子消费，防止 CSRF 与重放
    await this.wechatStates.put(state, {});
    return {
      url: `https://open.weixin.qq.com/connect/qrconnect?appid=${appId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`,
      state,
    };
  }

  // ── 微信身份统一查找（双 openid 命名空间 + unionid 归并） ──
  // 公众号(oa) 与 网站应用(site) 的 openid 互不通用；同一微信用户跨入口靠 unionid 归并。
  // 旧列 wechat_openid 仅作历史兜底（单列时代留下的账号），新流程不再写入。
  private async findUserByWechatIdentity(ids: { oaOpenid?: string; siteOpenid?: string; unionid?: string }) {
    const select: (keyof User)[] = [
      'id', 'email', 'name', 'avatar_url',
      'wechat_openid', 'wechat_openid_oa', 'wechat_openid_site', 'wechat_unionid', 'role',
    ];
    if (ids.oaOpenid) {
      const u = await this.userRepository.findOne({ where: { wechat_openid_oa: ids.oaOpenid }, select });
      if (u) return u;
    }
    if (ids.siteOpenid) {
      const u = await this.userRepository.findOne({ where: { wechat_openid_site: ids.siteOpenid }, select });
      if (u) return u;
    }
    if (ids.unionid) {
      const u = await this.userRepository.findOne({ where: { wechat_unionid: ids.unionid }, select });
      if (u) return u;
    }
    const legacyOpenid = ids.oaOpenid || ids.siteOpenid;
    if (legacyOpenid) {
      const u = await this.userRepository.findOne({ where: { wechat_openid: legacyOpenid }, select });
      if (u) return u;
    }
    return null;
  }

  async wechatCallback(code: string, state: string) {
    this.assertWechatLoginEnabled();
    // Verify state to prevent CSRF attacks
    // take() 原子「读取并删除」：state 只会被消费一次，且跨实例可见
    const stored = await this.wechatStates.take(state);
    if (!stored) {
      throw new BadRequestException('Invalid or expired state parameter');
    }

    const appId = process.env.WECHAT_APPID;
    // 网站应用(PC 扫码/绑定)与公众号是两套独立 AppID/OpenID 命名空间，
    // 绝不可静默回退到公众号 AppID，否则 openid 落错列 → 账号分裂。
    // 生产必须显式配置 WECHAT_APPID，缺失即禁用本路径而非带着错 AppID 跑。
    if (!appId) throw new BadRequestException('网站应用微信登录未配置（WECHAT_APPID）');
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
    // PC 扫码(网站应用) openid 落 wechat_openid_site 列；同一微信的公众号入口靠 unionid 归并，
    // 避免同一用户在 PC/微信内两个入口分裂成两个账号（各自 role 不同，
    // 典型表现：邮箱登录是 admin，微信登录却落到 role='user' 的小号）。
    let user = await this.findUserByWechatIdentity({ siteOpenid: openid, unionid });
    if (user) {
      let dirty = false;
      if (user.wechat_openid_site !== openid) { user.wechat_openid_site = openid; dirty = true; }
      if (unionid && user.wechat_unionid !== unionid) { user.wechat_unionid = unionid; dirty = true; }
      if (dirty) await this.userRepository.save(user);
    } else {
      user = this.userRepository.create({
        email: null,
        password_hash: '',
        name: wechatUser.nickname || '微信用户',
        wechat_openid_site: openid,
        wechat_unionid: unionid || null,
        email_verified: false,
        avatar_url: wechatUser.headimgurl || null,
      });
      await this.userRepository.save(user);
    }

    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      access_token: await this.jwtService.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
    };
  }

  // ── 微信内网页授权静默登录（snsapi_base，微信内置浏览器用） ──
  // 与 PC 弹窗扫码(qrconnect)不同：用户在微信内打开网页时，点需要登录的操作(创建团队/上传技能)
  // 直接静默授权，无需跳转邮箱登录页；openid 查/建逻辑复用下方同一套，避免账号分裂。
  // scope 说明：snsapi_base 静默无感但拿不到 unionid；snsapi_userinfo 弹一次授权页、可拿 unionid。
  // 流程默认 base 先行（老用户无感），新用户由 mp-callback 识别后升级为 userinfo 再授权一次。
  async getWechatMpAuthUrl(redirect: string, scope: 'snsapi_base' | 'snsapi_userinfo' = 'snsapi_base') {
    this.assertWechatLoginEnabled();
    if (!redirect || !redirect.startsWith('/')) {
      throw new BadRequestException('非法跳转地址');
    }
    // 公众号网页授权（snsapi_base）必须用「公众号」凭证 WECHAT_OA_APPID：
    // 网页授权域名配在该公众号下，且与 PC 网站应用扫码登录(WECHAT_APPID / wx4e9b…) 是两套独立 AppID / OpenID 命名空间，不可混用。
    const appId = process.env.WECHAT_OA_APPID || 'wxb2537aa7600236a7';
    const appSecret = process.env.WECHAT_OA_APPSECRET;
    if (!appId || !appSecret) {
      throw new BadRequestException('公众号网页授权未配置（WECHAT_OA_APPID / WECHAT_OA_APPSECRET）');
    }
    const base = process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com';
    const callbackUri = encodeURIComponent(`${base}/api/auth/wechat/mp-callback?rd=${encodeURIComponent(redirect)}`);
    const state = crypto.randomBytes(16).toString('hex');
    await this.wechatStates.put(state, {});
    return {
      url: `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${appId}&redirect_uri=${callbackUri}&response_type=code&scope=${scope}&state=${state}#wechat_redirect`,
    };
  }

  async wechatMpLogin(code: string, state: string, redirect: string) {
    this.assertWechatLoginEnabled();
    const stored = await this.wechatStates.take(state);
    if (!stored) {
      throw new BadRequestException('state 无效或已过期');
    }
    if (!redirect || !redirect.startsWith('/')) {
      throw new BadRequestException('非法跳转地址');
    }
    const appId = process.env.WECHAT_OA_APPID || 'wxb2537aa7600236a7';
    const appSecret = process.env.WECHAT_OA_APPSECRET;
    if (!appSecret) throw new BadRequestException('公众号 AppSecret(WECHAT_OA_APPSECRET) 未配置');
    // 官方文档：unionid 仅当 scope=snsapi_userinfo 时返回；snsapi_base 静默授权只给 openid。
    const tokenRes = await fetch(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${appSecret}&code=${code}&grant_type=authorization_code`
    );
    const tokenData = await tokenRes.json();
    if (tokenData.errcode) throw new BadRequestException(`微信登录失败: ${tokenData.errmsg}`);
    const { openid, unionid, access_token } = tokenData;
    const isUserinfoScope = String(tokenData.scope || '').includes('snsapi_userinfo');

    // 1) 公众号 openid 命中 → 老用户直接登录（snsapi_base 全程无感）
    let user = await this.findUserByWechatIdentity({ oaOpenid: openid });
    if (user) {
      if (user.wechat_openid_oa !== openid) {
        user.wechat_openid_oa = openid;
        await this.userRepository.save(user);
      }
      const payload = { sub: user.id, email: user.email, role: user.role };
      return {
        access_token: await this.jwtService.signAsync(payload),
        user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
        redirect,
      };
    }

    // 2) 查无此人且拿不到 unionid（snsapi_base）→ 通知调用方升级为 snsapi_userinfo 再授权一次，
    //    拿到 unionid 才能与 PC 扫码登录的账号归并。若已是 userinfo 仍无 unionid
    //    （公众号未绑定开放平台），不再循环升级，按公众号 openid 兜底建号。
    if (!unionid && !isUserinfoScope) {
      return { needUserinfoAuth: true as const, redirect };
    }

    // 3) snsapi_userinfo：可拉昵称/头像；按 unionid 归并 PC 账号或新建
    let wechatUser: { nickname?: string; headimgurl?: string } = {};
    if (isUserinfoScope) {
      const userRes = await fetch(
        `https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}`
      );
      wechatUser = await userRes.json();
    }

    user = unionid ? await this.findUserByWechatIdentity({ unionid }) : null;
    if (user) {
      let dirty = false;
      if (user.wechat_openid_oa !== openid) { user.wechat_openid_oa = openid; dirty = true; }
      if (unionid && user.wechat_unionid !== unionid) { user.wechat_unionid = unionid; dirty = true; }
      if (dirty) await this.userRepository.save(user);
    } else {
      user = this.userRepository.create({
        email: null,
        password_hash: '',
        name: wechatUser.nickname || '微信用户',
        wechat_openid_oa: openid,
        wechat_unionid: unionid || null,
        email_verified: false,
        avatar_url: wechatUser.headimgurl || null,
      });
      await this.userRepository.save(user);
    }

    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      access_token: await this.jwtService.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
      redirect,
    };
  }

  // ── 本地开发：模拟微信登录 ───────────────
  /**
   * 本地开发模拟微信登录：跳过微信 OAuth 直接建号并签发 7 天有效 JWT。
   *
   * ⚠️ **生产必须禁用** —— 这是一个无需任何凭证即可换取有效 JWT 的后门
   * （POST /api/auth/wechat/mock-login 无需登录、无需验证码、无需微信授权）。
   * 门禁放在 service 而非 controller：controller 只是入口之一，放在这里能同时
   * 挡住将来任何新增的调用路径。生产返回 404（当作路由不存在），不暴露其存在。
   */
  async mockWechatLogin(nickname?: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const mockOpenId = 'dev_mock_openid_' + Date.now();
    const mockName = nickname || '微信用户(测试)';
    let user = await this.userRepository.findOne({
      where: { wechat_openid: mockOpenId },
      select: ['id', 'email', 'name', 'avatar_url', 'wechat_openid', 'wechat_unionid', 'role'],
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
    const payload = { sub: user.id, email: user.email, role: user.role };
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

  // ── 微信绑定（已登录会话发起，避免重复账号） ──
  async getWechatBindUrl(userId: string) {
    this.assertWechatLoginEnabled();
    const appId = process.env.WECHAT_APPID;
    // 网站应用(PC 扫码/绑定)与公众号是两套独立 AppID/OpenID 命名空间，
    // 绝不可静默回退到公众号 AppID，否则 openid 落错列 → 账号分裂。
    // 生产必须显式配置 WECHAT_APPID，缺失即禁用本路径而非带着错 AppID 跑。
    if (!appId) throw new BadRequestException('网站应用微信登录未配置（WECHAT_APPID）');
    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
    const redirectUri = encodeURIComponent(`${base}/api/auth/wechat/bind-callback`);
    const state = crypto.randomBytes(16).toString('hex');
    // 绑定态关联当前登录用户，回调据此把 openid 落到正确账号
    await this.wechatBindStates.put(state, { userId });
    return {
      url: `https://open.weixin.qq.com/connect/qrconnect?appid=${appId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`,
      state,
    };
  }

  async completeWechatBind(code: string, state: string) {
    this.assertWechatLoginEnabled();
    const stored = await this.wechatBindStates.take(state);
    if (!stored) {
      throw new BadRequestException('Invalid or expired state parameter');
    }
    const userId = stored.userId;

    const appId = process.env.WECHAT_APPID;
    // 网站应用(PC 扫码/绑定)与公众号是两套独立 AppID/OpenID 命名空间，
    // 绝不可静默回退到公众号 AppID，否则 openid 落错列 → 账号分裂。
    // 生产必须显式配置 WECHAT_APPID，缺失即禁用本路径而非带着错 AppID 跑。
    if (!appId) throw new BadRequestException('网站应用微信登录未配置（WECHAT_APPID）');
    const appSecret = process.env.WECHAT_APPSECRET;
    if (!appSecret) throw new BadRequestException('WeChat AppSecret not configured');

    const tokenRes = await fetch(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${appSecret}&code=${code}&grant_type=authorization_code`,
    );
    const tokenData = await tokenRes.json();
    if (tokenData.errcode) throw new BadRequestException(`微信绑定失败: ${tokenData.errmsg}`);
    const { openid, unionid, access_token } = tokenData;

    const userRes = await fetch(
      `https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}`,
    );
    const wechatUser = await userRes.json();

    // 冲突检查：该微信已落在其他账号（公众号/网站应用 openid 或 unionid 任一命中即视为同一微信）
    const conflict = await this.findUserByWechatIdentity({ siteOpenid: openid, unionid });
    if (conflict && conflict.id !== userId) {
      // 已绑在无邮箱的微信小号 → 合并进当前(邮箱)账号；已绑在有邮箱的真实账号 → 拒绝
      if (conflict.email) throw new BadRequestException('该微信已绑定其他账号');
      await this.mergeAccounts(conflict.id, userId);
    }

    // PC 绑定(网站应用) openid 落 wechat_openid_site 列；显式 select 以便读取既有 unionid 做兜底
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'wechat_openid_site', 'wechat_unionid', 'avatar_url'],
    });
    user.wechat_openid_site = openid;
    user.wechat_unionid = unionid || user.wechat_unionid || null;
    if (wechatUser.headimgurl) user.avatar_url = wechatUser.headimgurl;
    await this.userRepository.save(user);
    return { ok: true };
  }

  // ── 绑定邮箱（已登录会话发起；邮箱已属他人时自动合并账号） ──
  async bindEmail(userId: string, email: string, code: string, password?: string) {
    await this.verifyCode(email, code);
    // ⚠️ 必须显式 select 微信身份列（select:false 字段默认不加载），否则冲突判断读不到值，
    // 会导致已绑微信的邮箱账号在合并时被错误覆盖微信身份。
    const currentUser = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'email', 'name', 'avatar_url', 'email_verified', 'password_hash', 'wechat_openid', 'wechat_openid_oa', 'wechat_openid_site', 'wechat_unionid'],
    });
    if (!currentUser) throw new NotFoundException('User not found');

    const existing = await this.userRepository.findOne({
      where: { email },
      select: ['id', 'wechat_openid', 'wechat_openid_oa', 'wechat_openid_site', 'wechat_unionid'],
    });
    if (existing && existing.id !== userId) {
      // 邮箱已被另一账号占用：把当前(多为微信小号)账号合并进该邮箱账号。
      // 双方都持有微信身份且完全不重叠（双 openid + unionid 无一相同）→ 是两个不同微信用户，拒绝合并。
      const curIds = [currentUser.wechat_openid, currentUser.wechat_openid_oa, currentUser.wechat_openid_site, currentUser.wechat_unionid].filter(Boolean);
      const exIds = [existing.wechat_openid, existing.wechat_openid_oa, existing.wechat_openid_site, existing.wechat_unionid].filter(Boolean);
      if (exIds.length > 0 && !exIds.some((v) => curIds.includes(v))) {
        throw new BadRequestException('该邮箱已绑定其他微信账号，无法合并');
      }
      await this.mergeAccounts(userId, existing.id);
      await this.userRepository.update(existing.id, { email_verified: true });
      const merged = await this.userRepository.findOne({ where: { id: existing.id } });
      const payload = { sub: merged.id, email: merged.email, role: merged.role };
      return {
        access_token: await this.jwtService.signAsync(payload),
        user: { id: merged.id, email: merged.email, name: merged.name, avatar_url: merged.avatar_url },
        merged: true,
      };
    }

    // 无冲突：普通绑定
    currentUser.email = email;
    currentUser.email_verified = true;
    if (password) {
      const salt = await bcrypt.genSalt();
      currentUser.password_hash = await bcrypt.hash(password, salt);
    }
    await this.userRepository.save(currentUser);
    const payload = { sub: currentUser.id, email, role: currentUser.role };
    return {
      access_token: await this.jwtService.signAsync(payload),
      user: { id: currentUser.id, email, name: currentUser.name, avatar_url: currentUser.avatar_url },
      merged: false,
    };
  }

  async setPassword(userId: string, newPassword: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const salt = await bcrypt.genSalt();
    user.password_hash = await bcrypt.hash(newPassword, salt);
    await this.userRepository.save(user);
    return { ok: true };
  }

  /**
   * 合并账号：把 fromId 的数据(订阅/通知/技能)迁移到 toId 并去重，迁移微信身份，删除 fromId。
   * 用于「邮箱用户误点微信登录生成小号」后的自动合并，避免用户持有两个账号。
   */
  private async mergeAccounts(fromId: string, toId: string) {
    await this.dataSource.transaction(async (manager) => {
      const subRepo = manager.getRepository(Subscription);
      const notiRepo = manager.getRepository(Notification);
      const skillRepo = manager.getRepository(Skill);
      const userRepo = manager.getRepository(User);

      // 订阅去重：删除 from 中与 to 重复的订阅，避免唯一约束冲突
      await manager.query(
        `DELETE FROM subscriptions s WHERE s.subscriber_id = $1 AND EXISTS (SELECT 1 FROM subscriptions e WHERE e.subscriber_id = $2 AND e.target_type = s.target_type AND e.target_id = s.target_id)`,
        [fromId, toId],
      );
      await subRepo.update({ subscriber_id: fromId }, { subscriber_id: toId });
      await notiRepo.update({ user_id: fromId }, { user_id: toId });
      await skillRepo.update({ owner_user_id: fromId }, { owner_user_id: toId });

      // 团队归属：把 from 拥有的团队转交给 to。teams.owner_user_id 是 RESTRICT 外键（无 ON DELETE），
      // 若不在删除 from 前改掉，删除 from 会因外键违反而失败，导致整个合并事务回滚。
      await manager.query(`UPDATE teams SET owner_user_id = $2 WHERE owner_user_id = $1`, [fromId, toId]);

      // 团队成员：先删 from 中与 to 重复的成员行（同一团队 to 已是成员，避免主键冲突），再迁移剩余
      await manager.query(
        `DELETE FROM team_members tm WHERE tm.user_id = $1 AND EXISTS (SELECT 1 FROM team_members e WHERE e.team_id = tm.team_id AND e.user_id = $2)`,
        [fromId, toId],
      );
      await manager.query(`UPDATE team_members SET user_id = $2 WHERE user_id = $1`, [fromId, toId]);

      // 评论 / 事件 / 反馈：转移归属。否则删除 from 时，comments/team_members 的 CASCADE 外键会
      // 连带删除 from 的数据，events/feedbacks 的 SET NULL 外键会丢失归属，造成数据丢失。
      await manager.query(`UPDATE comments SET user_id = $2 WHERE user_id = $1`, [fromId, toId]);
      await manager.query(`UPDATE events SET user_id = $2 WHERE user_id = $1`, [fromId, toId]);
      await manager.query(`UPDATE feedbacks SET user_id = $2 WHERE user_id = $1`, [fromId, toId]);

      // 迁移微信身份到目标（仅填补目标缺失项，不覆盖已有身份）
      // ⚠️ wechat_* 是 select:false 字段，普通 findOne 读不到，必须显式 select，
      // 否则 from.wechat_* 为 undefined，合并后微信身份丢失、微信登录失效。
      const from = await userRepo.findOne({ where: { id: fromId }, select: ['id', 'wechat_openid', 'wechat_openid_oa', 'wechat_openid_site', 'wechat_unionid', 'avatar_url'] });
      const to = await userRepo.findOne({ where: { id: toId }, select: ['id', 'wechat_openid', 'wechat_openid_oa', 'wechat_openid_site', 'wechat_unionid', 'avatar_url'] });
      if (from && to) {
        let dirty = false;
        if (!to.wechat_openid && from.wechat_openid) { to.wechat_openid = from.wechat_openid; dirty = true; }
        if (!to.wechat_openid_oa && from.wechat_openid_oa) { to.wechat_openid_oa = from.wechat_openid_oa; dirty = true; }
        if (!to.wechat_openid_site && from.wechat_openid_site) { to.wechat_openid_site = from.wechat_openid_site; dirty = true; }
        if (!to.wechat_unionid && from.wechat_unionid) { to.wechat_unionid = from.wechat_unionid; dirty = true; }
        if (!to.avatar_url && from.avatar_url) { to.avatar_url = from.avatar_url; dirty = true; }
        if (dirty) await userRepo.save(to);
      }
      await userRepo.delete({ id: fromId });
    });
  }
}
