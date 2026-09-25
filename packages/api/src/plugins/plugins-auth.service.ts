import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { PluginAuthRequest, PluginDevice } from './plugin-auth.entity';
import { User } from '../auth/user.entity';
import {
  genAuthCode,
  genDeviceToken,
  genPollSecret,
  hashSecret,
  safeEqualHex,
} from './plugin-auth.util';

/** 授权码有效期 10 分钟：够用户切到浏览器登录并确认，又短到无法被慢速枚举 */
const CODE_TTL_MS = 10 * 60 * 1000;
/** 同一个授权码最多被轮询多少次；超过即作废（配合 poll_secret 使枚举无意义） */
const MAX_POLL_ATTEMPTS = 40;
/** 推荐的轮询间隔（秒），由 start 返回给客户端 */
const POLL_INTERVAL_SEC = 3;

export interface StartInput {
  pluginSlug: string;
  deviceId: string;
  deviceName?: string;
  platform?: string;
}

/**
 * 插件设备授权登录。
 *
 * 与旧的「卡密」模型的关键区别：凭证不再是用户手抄的字符串，而是平台在用户于网页
 * 确认后签发的**设备令牌**——绑定发起授权的那台设备、服务端只存哈希、可逐台吊销。
 *
 * 三条不可省略的防护（任何一条缺失，这套就只是一个更花哨的卡密）：
 *  1. 轮询必须校验 poll_secret：光猜中 8 位授权码拿不到令牌。
 *  2. 审批时以 start 阶段记录的 device_id 为准，不信网页传参。
 *  3. 令牌明文永不入库；下发靠 `UPDATE ... WHERE consumed_at IS NULL` 原子抢占，只发一次。
 */
@Injectable()
export class PluginsAuthService {
  private readonly logger = new Logger(PluginsAuthService.name);

  constructor(
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
    @InjectRepository(PluginSubscription)
    private readonly subRepo: Repository<PluginSubscription>,
    @InjectRepository(PluginDevice)
    private readonly deviceRepo: Repository<PluginDevice>,
    @InjectRepository(PluginAuthRequest)
    private readonly reqRepo: Repository<PluginAuthRequest>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  // ─────────────────────────── 插件侧（公开） ───────────────────────────

  /**
   * 发起授权。返回授权码 + 轮询凭据 + 用户应打开的授权页地址。
   * 插件负责展示授权码（或直接打开 verify_url）并开始轮询。
   */
  async start(input: StartInput) {
    const slug = String(input?.pluginSlug || '').trim().toLowerCase();
    const deviceId = String(input?.deviceId || '').trim();
    if (!slug) throw new BadRequestException('pluginSlug 必填');
    if (deviceId.length < 8) throw new BadRequestException('deviceId 不合法');

    const plugin = await this.pluginRepo.findOne({
      where: { slug, status: 'active' },
    });
    if (!plugin) throw new NotFoundException('插件不存在或未上架');

    const pollSecret = genPollSecret();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    // 授权码空间只有 1e8，理论上可能撞已有码；重试几次即可（进程内冲突概率极低）
    let saved: PluginAuthRequest | null = null;
    for (let i = 0; i < 5 && !saved; i++) {
      const code = genAuthCode();
      const dup = await this.reqRepo.findOne({ where: { code } });
      if (dup) continue;
      saved = await this.reqRepo.save(
        this.reqRepo.create({
          code,
          poll_secret_hash: hashSecret(pollSecret),
          plugin_id: plugin.id,
          device_id: deviceId,
          device_name: input.deviceName?.trim() || null,
          platform: input.platform?.trim() || null,
          status: 'pending',
          expires_at: expiresAt,
        }),
      );
    }
    if (!saved) throw new ConflictException('授权码生成失败，请重试');

    // 顺手清理过期请求（尽力而为，失败不影响主流程；无需外部 cron）
    this.cleanupExpired().catch(() => {});

    return {
      code: saved.code,
      poll_secret: pollSecret,
      verify_url: `${this.publicBaseUrl()}/plugin-auth?code=${saved.code}`,
      expires_in: Math.floor(CODE_TTL_MS / 1000),
      poll_interval: POLL_INTERVAL_SEC,
    };
  }

  /**
   * 轮询授权结果。必须同时提供 code 与 poll_secret。
   * 状态非终态时一律返回 200（客户端据此继续轮询），不做 404 —— 避免用状态码区分「码不存在」。
   */
  async poll(code: string, pollSecret: string) {
    const c = String(code || '').trim();
    const s = String(pollSecret || '').trim();
    if (!c || !s) return { status: 'expired' as const };

    const req = await this.reqRepo.findOne({ where: { code: c } });
    if (!req) return { status: 'expired' as const };

    // 凭据不符：不区分「码对凭据错」与「码不存在」，统一 expired
    if (!safeEqualHex(req.poll_secret_hash, hashSecret(s))) {
      return { status: 'expired' as const };
    }

    if (req.attempts >= MAX_POLL_ATTEMPTS || req.expires_at.getTime() < Date.now()) {
      return { status: 'expired' as const };
    }
    await this.reqRepo.increment({ id: req.id }, 'attempts', 1);

    if (req.status === 'denied') {
      return { status: 'denied' as const, reason: req.deny_reason || undefined };
    }
    if (req.status !== 'approved') {
      return { status: 'pending' as const };
    }
    if (req.consumed_at) {
      // 已下发过一次，不再下发（防重放）
      return { status: 'consumed' as const };
    }

    // 原子抢占：只有把 consumed_at 从 NULL 改为 now() 成功的那一次才允许下发令牌
    const claim = await this.reqRepo
      .createQueryBuilder()
      .update(PluginAuthRequest)
      .set({ consumed_at: () => 'now()' })
      .where('id = :id', { id: req.id })
      .andWhere('consumed_at IS NULL')
      .execute();
    if (!claim.affected) return { status: 'consumed' as const };

    // 到这里才生成令牌明文；DB 只落 sha256
    const device = await this.deviceRepo.findOne({
      where: {
        user_id: req.user_id,
        plugin_id: req.plugin_id,
        device_id: req.device_id,
      },
    });
    if (!device) {
      this.logger.warn(
        `授权请求 ${req.id} 已批准但未找到设备记录，无法下发令牌`,
      );
      return { status: 'expired' as const };
    }

    const token = genDeviceToken();
    device.token_hash = hashSecret(token);
    device.last_seen_at = new Date();
    await this.deviceRepo.save(device);

    const [plugin, sub, user, devicesUsed] = await Promise.all([
      this.pluginRepo.findOne({ where: { id: req.plugin_id } }),
      this.subRepo.findOne({
        where: { user_id: req.user_id, plugin_id: req.plugin_id },
      }),
      this.userRepo.findOne({
        where: { id: req.user_id },
        select: ['id', 'email', 'name'],
      }),
      this.countActiveDevices(req.user_id, req.plugin_id),
    ]);

    return {
      status: 'approved' as const,
      device_token: token,
      device_id: req.device_id,
      expires_at: sub?.expires_at?.toISOString(),
      sub_status: sub?.status,
      plugin: plugin ? { slug: plugin.slug, name: plugin.name } : undefined,
      user: user ? { email: user.email, name: user.name } : undefined,
      devices_used: devicesUsed,
      max_devices: plugin?.max_activations ?? 2,
    };
  }

  /**
   * 权益校验（插件每次启动/临近到期调用）。
   *
   * 设备不存在/令牌不匹配/已吊销一律返回统一的 valid:false（不区分原因，防探测）；
   * 订阅状态则明确返回，因为持有效令牌者本就是合法拥有者。
   *
   * 注意：**不按 plugin.status 拦截**。插件被下架停止售卖后，已付费用户仍应
   * 用到期满 —— 下架是停止获客，不是没收已购权益。
   */
  async entitlement(deviceToken: string, deviceId: string) {
    const token = String(deviceToken || '').trim();
    const did = String(deviceId || '').trim();
    if (!token || !did) return { valid: false as const, code: 'REAUTH' };

    const device = await this.deviceRepo.findOne({
      where: { token_hash: hashSecret(token) },
    });
    if (!device || device.revoked_at) {
      return { valid: false as const, code: 'REAUTH' };
    }
    if (device.device_id !== did) {
      // 令牌被拷到另一台机器：拒绝，且不透露该令牌其实有效
      this.logger.warn(
        `设备令牌与 deviceId 不匹配 plugin=${device.plugin_id} 期望=${device.device_id.slice(0, 8)}… 实收=${did.slice(0, 8)}…`,
      );
      return { valid: false as const, code: 'REAUTH' };
    }

    const sub = await this.subRepo.findOne({
      where: { user_id: device.user_id, plugin_id: device.plugin_id },
    });
    if (!sub || sub.status !== 'active' || sub.expires_at.getTime() <= Date.now()) {
      return {
        valid: false as const,
        code: 'SUBSCRIPTION_EXPIRED',
        status: sub?.status,
        expires_at: sub?.expires_at?.toISOString(),
      };
    }

    // 顺带更新最后活跃时间（客服排障用）
    this.deviceRepo
      .update({ id: device.id }, { last_seen_at: new Date() })
      .catch(() => {});

    const plugin = await this.pluginRepo.findOne({
      where: { id: device.plugin_id },
    });
    return {
      valid: true as const,
      expires_at: sub.expires_at.toISOString(),
      status: sub.status,
      plan: sub.plan,
      plugin: plugin ? { slug: plugin.slug, name: plugin.name } : undefined,
    };
  }

  // ─────────────────────────── 网页侧（需登录） ───────────────────────────

  /** 授权页用：展示是哪个插件在请求、当前已授权几台、该用户是否已订阅 */
  async pending(userId: string, code: string) {
    const c = String(code || '').trim();
    if (!c) throw new BadRequestException('缺少 code');
    const req = await this.reqRepo.findOne({ where: { code: c } });
    if (!req) throw new NotFoundException('授权请求不存在或已过期');
    if (req.expires_at.getTime() < Date.now()) {
      return { status: 'expired' as const };
    }

    const plugin = req.plugin_id
      ? await this.pluginRepo.findOne({ where: { id: req.plugin_id } })
      : null;
    const sub = plugin
      ? await this.subRepo.findOne({
          where: { user_id: userId, plugin_id: plugin.id },
        })
      : null;
    const subscribed =
      !!sub && sub.status === 'active' && sub.expires_at.getTime() > Date.now();

    return {
      status: req.status,
      deny_reason: req.deny_reason || undefined,
      plugin: plugin
        ? { slug: plugin.slug, name: plugin.name, tagline: plugin.tagline }
        : undefined,
      device_name: req.device_name,
      platform: req.platform,
      subscribed,
      subscription_expires_at: sub?.expires_at?.toISOString(),
      devices_used: plugin ? await this.countActiveDevices(userId, plugin.id) : 0,
      max_devices: plugin?.max_activations ?? 2,
    };
  }

  /**
   * 确认/拒绝授权。
   *
   * 上限校验放在这里（而不是轮询里）：用户点下确认的那一刻就该知道「已满 2 台」，
   * 错误要在正确的界面暴露；插件端只需要等一个终态。
   */
  async approve(userId: string, code: string, action: 'approve' | 'deny') {
    const c = String(code || '').trim();
    if (!c) throw new BadRequestException('缺少 code');
    const req = await this.reqRepo.findOne({ where: { code: c } });
    if (!req) throw new NotFoundException('授权请求不存在或已过期');
    if (req.expires_at.getTime() < Date.now()) {
      throw new BadRequestException('授权请求已过期，请在插件里重新发起');
    }
    if (req.status === 'approved') {
      return { ok: true, status: 'approved', already: true };
    }

    const deny = async (reason: string, message: string) => {
      req.status = 'denied';
      req.deny_reason = reason;
      req.user_id = userId;
      await this.reqRepo.save(req);
      return { ok: false, status: 'denied', reason, message };
    };

    if (action === 'deny') {
      return deny('USER_DENIED', '已拒绝本次授权');
    }

    const plugin = req.plugin_id
      ? await this.pluginRepo.findOne({ where: { id: req.plugin_id } })
      : null;
    if (!plugin) {
      return deny('NO_SUBSCRIPTION', '插件不存在或已下架');
    }

    const sub = await this.subRepo.findOne({
      where: { user_id: userId, plugin_id: plugin.id },
    });
    if (!sub || sub.status !== 'active') {
      return deny(
        'NO_SUBSCRIPTION',
        `你还没有订阅「${plugin.name}」，请先在插件市场完成订阅`,
      );
    }
    if (sub.expires_at.getTime() <= Date.now()) {
      return deny(
        'EXPIRED_SUBSCRIPTION',
        `「${plugin.name}」订阅已于 ${sub.expires_at.toLocaleDateString('zh-CN')} 到期，请续费后再授权`,
      );
    }

    // 设备上限：以 start 阶段记录的 device_id 为准（不信网页传参）
    const max = plugin.max_activations ?? 2;
    const existing = await this.deviceRepo.findOne({
      where: {
        user_id: userId,
        plugin_id: plugin.id,
        device_id: req.device_id,
      },
    });
    const used = await this.countActiveDevices(userId, plugin.id);

    if (existing && !existing.revoked_at) {
      // 该设备已授权过：直接放行（重复确认是幂等的），顺手补一下设备名
      if (req.device_name) existing.device_name = req.device_name;
      if (req.platform) existing.platform = req.platform;
      await this.deviceRepo.save(existing);
    } else {
      // 走到这里有两种情况：全新设备，或「曾被吊销的同一台设备重新授权」。
      // **两者都会净增一个活跃名额**，所以上限检查必须放在这之前 ——
      // 漏掉这条会出现绕过：吊销 A → 在别的机器授权占满 → A 再来授权，
      // 复用旧行把活跃数顶到 max 之上（曾实测可复现）。
      if (used >= max) {
        return deny(
          'ACTIVATION_LIMIT',
          `「${plugin.name}」最多授权 ${max} 台设备，当前已用满。请到「我的订阅」解绑一台后重试`,
        );
      }
      if (existing) {
        // 复用该行（唯一索引 (user_id, plugin_id, device_id) 保证不会出现重复行）
        existing.revoked_at = null;
        existing.token_hash = null; // 待 poll 阶段签发新令牌
        if (req.device_name) existing.device_name = req.device_name;
        if (req.platform) existing.platform = req.platform;
        await this.deviceRepo.save(existing);
      } else {
        await this.deviceRepo.save(
          this.deviceRepo.create({
            user_id: userId,
            plugin_id: plugin.id,
            device_id: req.device_id,
            device_name: req.device_name || null,
            platform: req.platform || null,
            token_hash: null,
          }),
        );
      }
    }

    req.status = 'approved';
    req.user_id = userId;
    req.deny_reason = null;
    await this.reqRepo.save(req);

    return {
      ok: true,
      status: 'approved',
      expires_at: sub.expires_at.toISOString(),
      devices_used: await this.countActiveDevices(userId, plugin.id),
      max_devices: max,
    };
  }

  // ─────────────────────────── 设备管理（账户页） ───────────────────────────

  async listDevices(userId: string, pluginId: string) {
    const devices = await this.deviceRepo.find({
      where: { user_id: userId, plugin_id: pluginId, revoked_at: null },
      order: { created_at: 'DESC' },
    });
    const plugin = await this.pluginRepo.findOne({ where: { id: pluginId } });
    return {
      devices: devices.map((d) => ({
        device_id: d.device_id,
        device_name: d.device_name,
        platform: d.platform,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at,
        // 尚未取走令牌 = 已批准但插件没完成激活
        pending: !d.token_hash,
      })),
      max_devices: plugin?.max_activations ?? 2,
    };
  }

  /** 吊销单台设备：令牌立即失效，下次启动插件需重新授权 */
  async revokeDevice(userId: string, pluginId: string, deviceId: string) {
    const d = await this.deviceRepo.findOne({
      where: { user_id: userId, plugin_id: pluginId, device_id: deviceId },
    });
    if (!d) throw new NotFoundException('未找到该设备授权记录');
    if (d.revoked_at) return { ok: true, already: true };
    d.revoked_at = new Date();
    d.token_hash = null; // 立刻失效，不等 token 过期（本来也没有过期时间）
    await this.deviceRepo.save(d);
    return { ok: true };
  }

  /** 全清：换机/重装前的粗粒度操作，等价于逐台吊销 */
  async revokeAllDevices(userId: string, pluginId: string) {
    await this.deviceRepo.update(
      { user_id: userId, plugin_id: pluginId, revoked_at: null },
      { revoked_at: new Date(), token_hash: null },
    );
    return { ok: true };
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private countActiveDevices(userId: string, pluginId: string): Promise<number> {
    return this.deviceRepo.count({
      where: { user_id: userId, plugin_id: pluginId, revoked_at: null },
    });
  }

  /** 删除超过 1 天的历史授权请求（有界批量，避免长事务） */
  private async cleanupExpired(): Promise<void> {
    await this.reqRepo.query(
      `DELETE FROM plugin_auth_requests WHERE id IN (
         SELECT id FROM plugin_auth_requests
         WHERE expires_at < now() - interval '1 day'
         LIMIT 500
       )`,
    );
  }

  private publicBaseUrl(): string {
    return (process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com').replace(
      /\/+$/,
      '',
    );
  }
}
