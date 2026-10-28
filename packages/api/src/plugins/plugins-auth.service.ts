import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { PluginAuthRequest, PluginDevice } from './plugin-auth.entity';
import { User } from '../auth/user.entity';
import {
  genAuthCode,
  genDeviceToken,
  genPollSecret,
  hashSecret,
  isSubscriptionEntitled,
  subFailReason,
  safeEqualHex,
  isTeamTier,
} from './plugin-auth.util';
import { resolvePluginSubscription } from './plugin-entitlement-resolve';
import {
  DeviceTierOption,
  deviceQuotaOfRow,
  listDeviceTierOptions,
  summarizeQuota,
} from './plugin-device-quota';

/** 授权码有效期 10 分钟：够用户切到浏览器登录并确认，又短到无法被慢速枚举 */
const CODE_TTL_MS = 10 * 60 * 1000;
/**
 * 同一个授权码最多被**用错凭据**试探多少次，超过即整条作废。
 *
 * ⚠️ 计数语义（2026-09-26 修正）：**只统计「凭据不匹配」的请求，合法轮询不计数**。
 * 旧实现每次轮询都 +1，于是 40 × 3 秒 = 2 分钟就撞上限 —— 而授权码本身有效 10 分钟。
 * 用户在授权页多花两分钟（先跳去订阅、再输密码）就会看到「我明明点了确认，插件却说已过期」，
 * 并且必须等满 10 分钟 TTL 才能重来。防枚举早已由 poll_secret 配对完成（光猜中 8 位码拿不到
 * 令牌），这个计数器只该用来掐「已知 code 但不知道 poll_secret」的暴力试探。
 */
const MAX_POLL_ATTEMPTS = 100;
/** 推荐的轮询间隔（秒），由 start 返回给客户端 */
const POLL_INTERVAL_SEC = 3;
/** 入参长度上限：device_id 是设备身份（超长直接拒），name/platform 只用于展示（截断） */
const DEVICE_ID_MAX = 128;
const DEVICE_NAME_MAX = 64;
const PLATFORM_MAX = 32;
/**
 * 设备令牌的**绝对**有效期（90 天）。超龄后 entitlement 返回 `REAUTH`，
 * 插件按约定清掉本地令牌、引导用户重新授权一次（订阅仍然有效，只是换一枚新令牌）。
 *
 * 为什么需要它：令牌的失效路径只有「手动解绑 / 后台吊销 / 订阅失效」，而订阅失效时令牌是
 * **保留**的（续费即复活）—— 等于一份外泄的令牌在长期订阅下永久可用。加上这条天花板，
 * 把最坏情况从「无限期」压到 90 天。
 */
const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** 展示类字段的裁剪：空白 → null；超长截断（拒绝会让整条授权流程莫名失败） */
function clip(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

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
 *
 * 2026-09-26 审计后的加固（对应 `plugin-coupling-security-report.html`）：
 *  · 轮询计数只统计「凭据不匹配」，合法轮询不再被 2 分钟卡死（见 MAX_POLL_ATTEMPTS）；
 *  · 设备上限校验进事务 + 行锁（原 check-then-act 并发可超 1 台）；
 *  · 「拒绝」改为终态；
 *  · pending/approve 对「不存在」与「已过期」返回同一结果，不再当存在性探测器；
 *  · 设备令牌加 90 天绝对有效期（TOKEN_MAX_AGE_MS）。
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
    // device_id 会参与「令牌与设备是否同源」的判定，属于身份字段：越界一律拒绝，不做截断。
    if (deviceId.length < 8 || deviceId.length > DEVICE_ID_MAX) {
      throw new BadRequestException(
        `deviceId 不合法：长度需在 8-${DEVICE_ID_MAX} 之间`,
      );
    }
    // deviceName / platform 只用于账户页与授权页展示。历史上完全不校验 → 可写入几 MB 的记录
    // （受全局限流约束，影响有限）。这里截断而不是拒绝：它们可能来自 user-agent 之类的自由文本。
    const deviceName = clip(input.deviceName, DEVICE_NAME_MAX);
    const platform = clip(input.platform, PLATFORM_MAX);

    /** 2026-09-27 修正：下架后仍允许已付费用户发起授权 / 重新授权。 */
    const plugin = await this.pluginRepo.findOne({
      where: { slug },
    });
    if (!plugin) throw new NotFoundException('插件不存在');

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
          device_name: deviceName,
          platform,
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
   *
   * 计数规则见 MAX_POLL_ATTEMPTS：**只有凭据不匹配才计数**，合法轮询不计。
   * 于是「合法用户的轮询上限」= 授权码 TTL（10 分钟 / 3 秒 ≈ 200 次），不再有 2 分钟硬伤。
   */
  async poll(code: string, pollSecret: string) {
    const c = String(code || '').trim();
    const s = String(pollSecret || '').trim();
    if (!c || !s) return { status: 'expired' as const };

    const req = await this.reqRepo.findOne({ where: { code: c } });
    if (!req) return { status: 'expired' as const };

    // 凭据不符：不区分「码对凭据错」与「码不存在」，统一 expired。
    // 这是唯一会写入 attempts 的分支 —— 它代表「有人拿着 code 在猜 poll_secret」。
    if (!safeEqualHex(req.poll_secret_hash, hashSecret(s))) {
      await this.reqRepo.increment({ id: req.id }, 'attempts', 1);
      return { status: 'expired' as const };
    }

    // 被暴力试探过的码整条作废（如 code 已泄露给第三方）。
    // 合法轮询不计数，永远撞不到这条。
    if (req.attempts >= MAX_POLL_ATTEMPTS) {
      return { status: 'expired' as const };
    }
    if (req.expires_at.getTime() < Date.now()) {
      return { status: 'expired' as const };
    }

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
    // 绝对有效期起点：每次签发都刷新（重新授权 = 新令牌 = 新的 90 天）
    device.token_issued_at = new Date();
    device.last_seen_at = new Date();
    await this.deviceRepo.save(device);

    /**
     * ★ 2026-10-28 修复：这里原来按 `(user_id, plugin_id = 主插件)` 直查订阅行。
     *
     * 0042「一档一行」之后，订阅行的 plugin_id 变成**用户买的那个商品**（基础版 /
     * -year / -b2b / -trial），只有「买过基础版」的人才存在 plugin_id = 主插件 的行。于是：
     *   · 买过基础版的人 → 查到基础版行 → 扩展端登录后显示「基础版」（哪怕他还有 Team 专业版）
     *   · 只买过档位商品的人 → 查不到 → expires_at / sub_status 直接 undefined
     * 而 `entitlement` / `pending` / `approve` 早就走 resolvePluginSubscription 了，
     * 唯独登录回调这一处漏了 —— 这就是「登录后优先显示个人版」的根因。
     *
     * 现在统一走同一个解析函数：按 root_plugin_id 取该插件族的全部行，
     * 排序「有权 > 团队/team 档 > 到期最晚」，与扩展端后续 entitlement 的结论完全一致。
     */
    const [plugin, resolved, user, devicesUsed, tierOptions] = await Promise.all([
      this.pluginRepo.findOne({ where: { id: req.plugin_id } }),
      resolvePluginSubscription(this.subRepo.manager, req.user_id, req.plugin_id),
      this.userRepo.findOne({
        where: { id: req.user_id },
        select: ['id', 'email', 'name'],
      }),
      this.countActiveDevices(req.user_id, req.plugin_id),
      listDeviceTierOptions(this.subRepo.manager, req.user_id, req.plugin_id),
    ]);
    const sub = resolved?.sub ?? null;
    // 用户买的那个商品（用于把「Team 专业版」而不是「基础版」告诉扩展端）
    const plan = sub
      ? await this.pluginRepo.findOne({ where: { id: sub.plugin_id } })
      : null;
    /**
     * 档位与设备额度**同一口径**（2026-10-29 定案，收口在 plugin-auth.util /
     * plugin-device-quota，不要在别处另写一份）：
     *   · tier = 本行可授权账号数 > 1（= 开放 AI 的唯一判据）
     *   · 设备额度 = 该用户在本插件族内所有**在期**档位的额度之和（一档一台）
     */
    const tier = isTeamTier(sub) ? ('team' as const) : ('personal' as const);
    const { max_devices: maxDevices } = summarizeQuota(tierOptions, devicesUsed);

    return {
      status: 'approved' as const,
      device_token: token,
      device_id: req.device_id,
      expires_at: sub?.expires_at?.toISOString(),
      sub_status: sub?.status,
      /** 权益档位（新增）：personal | team。扩展端据此挂/不挂 AI UI，不必等 entitlement */
      tier,
      /** 命中的那个商品（新增）：Team 专业版 / Pro 标准版 / 基础版 / 新用户试用 */
      plan: plan ? { slug: plan.slug, name: plan.name } : undefined,
      /** 不改动：仍为主插件信息，兼容已发布扩展端读 plugin.slug 判定身份 */
      plugin: plugin ? { slug: plugin.slug, name: plugin.name } : undefined,
      user: user ? { email: user.email, name: user.name } : undefined,
      devices_used: devicesUsed,
      max_devices: maxDevices,
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

    /**
     * 令牌绝对有效期。超龄 → REAUTH（而不是 SUBSCRIPTION_EXPIRED）。
     *
     * 两类失效在插件端的处理是相反的：REAUTH 会清掉本地令牌，SUBSCRIPTION_EXPIRED 会保留
     * —— 所以这里必须用 REAUTH，否则插件会以为「订阅没了」，把用户的续费状态也一起清掉。
     * token_issued_at 为 NULL 的行（老数据 / 迁移前就存在的记录）不拦，避免上线即误伤。
     */
    if (device.token_issued_at) {
      const issuedAt = new Date(device.token_issued_at).getTime();
      if (Number.isFinite(issuedAt) && Date.now() - issuedAt > TOKEN_MAX_AGE_MS) {
        this.logger.warn(
          `设备令牌已超过 ${Math.round(TOKEN_MAX_AGE_MS / 86400000)} 天，要求重新授权 device=${device.device_id.slice(0, 8)}…`,
        );
        return { valid: false as const, code: 'REAUTH' };
      }
    }

    // 席位制（0035）：本人订阅 OR 所在团队的有效团队订阅（resolvePluginSubscription 收口）
    const resolved = await resolvePluginSubscription(
      this.subRepo.manager,
      device.user_id,
      device.plugin_id,
    );
    const sub = resolved?.sub ?? null;
    if (!resolved || !resolved.entitled) {
      return {
        valid: false as const,
        code: 'SUBSCRIPTION_EXPIRED',
        status: sub?.status,
        expires_at: sub?.expires_at
          ? new Date(sub.expires_at).toISOString()
          : undefined,
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
      /** 订阅类型：AI 功能（推送 / 自动采集）仅团队档开放，插件端按此挂或不挂 AI UI。
       *  唯一判据 = 本行可授权账号数 > 1（见 plugin-auth.util isTeamTier）：
       *  基础版 / Pro（包年）/ 试用都是 1 席 → personal，Team 专业版 3 席 → team。
       *  团队席位覆盖的成员同样命中团队行，因此也返回 team。 */
      tier: isTeamTier(sub) ? ('team' as const) : ('personal' as const),
      plugin: plugin ? { slug: plugin.slug, name: plugin.name } : undefined,
    };
  }

  // ─────────────────────────── 网页侧（需登录） ───────────────────────────

  /**
   * 授权页用：展示是哪个插件在请求、当前已授权几台、该用户是否已订阅。
   *
   * ★ 必须返回 `code` 与 `created_at`：设备码流程（RFC 8628）的固有风险是**钓鱼** ——
   *   攻击者在自己机器上发起授权拿到 code，把链接发给受害者，受害者一点「确认」，
   *   攻击者那台机器就拿到令牌。行业标准缓解手段就是「授权页展示用户可核对的信息」：
   *   授权码（插件端会显示同一个码，两边可比对）+ 请求发起时间（判断「这是我刚点的吗」）。
   *
   * ★ 「不存在」与「已过期」返回**同一个结果**：不同的响应会让这个接口变成
   *   8 位码的存在性探测器（枚举码即可确认「此刻是否有人正在授权、设备叫什么」）。
   */
  async pending(userId: string, code: string) {
    const c = String(code || '').trim();
    // 注意：这里不再对空 code 抛 400 —— 空值同样走统一结果，保持响应形态唯一。
    if (!c) return { status: 'expired' as const };
    const req = await this.reqRepo.findOne({ where: { code: c } });
    if (!req || req.expires_at.getTime() < Date.now()) {
      return { status: 'expired' as const };
    }

    const plugin = req.plugin_id
      ? await this.pluginRepo.findOne({ where: { id: req.plugin_id } })
      : null;
    // 席位制（0035）：本人订阅 OR 团队席位覆盖
    const resolved = plugin
      ? await resolvePluginSubscription(this.subRepo.manager, userId, plugin.id)
      : null;
    const sub = resolved?.sub ?? null;
    // 「已订阅」标记供授权页分流用：cancelled 但未到期同样算已订阅（否则用户明明还能用，
    // 授权页却引导他去「重新订阅」）
    const subscribed = !!resolved?.entitled;

    /**
     * 档位列表（0046）：授权页据此渲染「授权使用」下拉。
     *
     * 一档一台，所以每档单独算额度；`devices_used` 用真实设备数（不是各行 used 之和，
     * 历史行 subscription_id 为空不属于任何一档，相加会漏算）。
     * 在期内档位为 0 时 `max_devices` = 0，但页面早已因 subscribed=false 挡住授权按钮。
     */
    const tierOptions: DeviceTierOption[] = plugin
      ? await listDeviceTierOptions(this.subRepo.manager, userId, plugin.id)
      : [];
    const devicesUsed = plugin ? await this.countActiveDevices(userId, plugin.id) : 0;
    const quota = summarizeQuota(tierOptions, devicesUsed);
    // 在期档位里到期最晚的那个，用于「订阅状态」那一行的日期展示
    const entitledExpiries = tierOptions
      .filter((o) => o.entitled && o.expires_at)
      .map((o) => o.expires_at as string)
      .sort();
    const latestExpiry =
      entitledExpiries.length > 0
        ? entitledExpiries[entitledExpiries.length - 1]
        : sub?.expires_at?.toISOString();

    return {
      status: req.status,
      deny_reason: req.deny_reason || undefined,
      /** 供用户与插件端显示的授权码（比对用；本身不是凭据，拿它换不到令牌） */
      code: req.code,
      /** 发起时间：用户据此判断「是不是我刚才点的那一下」 */
      created_at: req.created_at ? new Date(req.created_at).toISOString() : undefined,
      plugin: plugin
        ? { slug: plugin.slug, name: plugin.name, tagline: plugin.tagline }
        : undefined,
      // 设备名由发起方自填、接口未认证 —— 页面上必须标注「仅供参考」，不能当事实展示。
      device_name: req.device_name,
      platform: req.platform,
      subscribed,
      subscription_expires_at: latestExpiry,
      devices_used: quota.devices_used,
      max_devices: quota.max_devices,
      /**
       * 可授权的订阅档位（新增，0046）。前端规则：
       *   · 在期内且未满的档位 ≥ 2 → 出下拉，默认选 recommended 那项
       *   · 只有 1 项 → 不出下拉，只显示文案（单档用户零感知）
       *   · 已满 / 已过期 → 置灰但仍展示（让用户知道「我买过、只是用完了」）
       */
      options: tierOptions,
    };
  }

  /**
   * 确认/拒绝授权。
   *
   * 上限校验放在这里（而不是轮询里）：用户点下确认的那一刻就该知道「已满」，
   * 错误要在正确的界面暴露；插件端只需要等一个终态。
   *
   * ★ 0046「一档一台」：`subscriptionId` 是用户在授权页下拉里选的那一档。
   *   · 传了 → 必须属于本人、属于本插件族、在期内、该档还有名额（四条校验缺一不可，
   *     否则可以拿别人的 subscription_id 蹭名额，或用已退款的行反复授权）
   *   · 没传（老客户端 / 单档用户页面不出下拉）→ 自动选「在期内且未满、到期最晚」
   */
  async approve(
    userId: string,
    code: string,
    action: 'approve' | 'deny',
    subscriptionId?: string,
  ) {
    const c = String(code || '').trim();
    const req = c ? await this.reqRepo.findOne({ where: { code: c } }) : null;
    // 「不存在」与「已过期」用同一状态码 + 同一措辞：不让本接口变成 8 位码的存在性探测器
    if (!req || req.expires_at.getTime() < Date.now()) {
      throw new BadRequestException('授权请求不存在或已过期，请在插件里重新发起');
    }
    if (req.status === 'approved') {
      return { ok: true, status: 'approved', already: true };
    }
    if (req.status === 'denied') {
      // ★ 「拒绝」是终态。旧实现只对 approved 短路，于是被拒的请求还能再被批准 ——
      //   用户先点「拒绝」再点「确认」等于没拒绝过，语义上「拒绝」就不成立了。
      //   要重新授权，从插件重新发起即可（新 code，10 分钟内有效）。
      return {
        ok: false,
        status: 'denied',
        already: true,
        reason: req.deny_reason || 'USER_DENIED',
        message: '本次授权已被拒绝。如需继续使用，请在插件里重新发起授权。',
      };
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

    /**
     * 档位选择（0046）。options 已按「在期内 → 到期最晚」排好序，
     * `recommended` 标记的是第一个「在期内且未满」的档位。
     */
    const options = await listDeviceTierOptions(
      this.subRepo.manager,
      userId,
      plugin.id,
    );
    if (options.length === 0) {
      return deny(
        'NO_SUBSCRIPTION',
        `你还没有订阅「${plugin.name}」，请先在插件市场完成订阅`,
      );
    }
    const wantedId = String(subscriptionId || '').trim();
    const chosen = wantedId
      ? options.find((o) => o.subscription_id === wantedId)
      : options.find((o) => o.recommended) ?? options[0];
    if (!chosen) {
      // 传了 id 但不在「本人可用的档位」里 —— 越权或该行已失效。
      // 抛 400 而不是把请求打成 denied：这是**页面过期**（比如另一台机器先占掉了那一档
      // 或后台刚改了订阅），用户刷新后就能继续，不该逼他回插件重新发起。
      throw new BadRequestException('所选订阅不属于你或已失效，请刷新授权页后重新选择');
    }
    const planLabel = chosen.plan_name || plugin.name;

    // cancelled 但未到期 → 有权（见 isSubscriptionEntitled）；这里只剩「已到期」与
    // 「后台强制终止」两种成因，文案要分开，别让被终止的用户以为自己只是过期了。
    if (!chosen.entitled) {
      return deny(
        'EXPIRED_SUBSCRIPTION',
        chosen.expires_at
          ? `「${planLabel}」订阅已于 ${new Date(chosen.expires_at).toLocaleDateString('zh-CN')} 到期，请续费后再授权`
          : `「${planLabel}」的订阅已失效，请重新订阅后再授权`,
      );
    }
    if (chosen.full) {
      // 名额满**不是终态**：用户可以在授权页改选别的档位，或去账号页解绑后重试。
      // 所以这里抛 400（页面留在原地显示错误），而不是把请求标成 denied。
      throw new BadRequestException(
        `「${planLabel}」的 ${chosen.quota} 台设备名额已用满，请到「我的订阅」解绑一台，或回到授权页改选其他订阅`,
      );
    }

    const max = chosen.quota;

    /**
     * 设备上限：以 start 阶段记录的 device_id 为准（不信网页传参）。
     *
     * ⚠️ 「查活跃数 → 判断 → 写设备行」必须是**原子**的。旧实现是 check-then-act：
     *    两台新机器同时点确认，各自读到 used = max-1，然后都写入 → 活跃数顶到 max+1。
     *    互斥量选**用户选中的那条订阅行** —— 同一档的并发授权在此串行化。
     */
    const conflict = await this.subRepo.manager.transaction(async (m) => {
      const subRepo = m.getRepository(PluginSubscription);
      const devRepo = m.getRepository(PluginDevice);

      const locked = await subRepo.findOne({
        where: { id: chosen.subscription_id },
        lock: { mode: 'pessimistic_write' },
      });
      // 锁内才是真相：拿到锁后重新确认订阅（前面那次检查只是为了文案更具体）
      if (!locked) {
        return {
          reason: 'INVALID_SUBSCRIPTION',
          message: '所选订阅已失效，请刷新授权页后重试',
        };
      }
      // 锁内复查归属：个人行必须是本人；团队行必须是本人仍在册
      // （resolve 之后、拿锁之前被踢出团的用户，本次授权仍要拒绝——否则刚被移除的
      //  成员还能落地一台设备；下一次 entitlement 会失权，但令牌已经签出去了）
      if (locked.team_id) {
        const mem: Array<{ ok: number }> = await m.query(
          `SELECT 1 AS ok FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
          [locked.team_id, userId],
        );
        if (!mem || mem.length === 0) {
          return {
            reason: 'NO_SUBSCRIPTION',
            message: `你已不在「${planLabel}」的订阅团队中，请联系团长邀请`,
          };
        }
      } else if (locked.user_id !== userId) {
        return {
          reason: 'INVALID_SUBSCRIPTION',
          message: '所选订阅不属于你，请刷新授权页后重试',
        };
      }
      if (!isSubscriptionEntitled(locked)) {
        return {
          reason: 'EXPIRED_SUBSCRIPTION',
          message:
            subFailReason(locked) === 'expired'
              ? `「${planLabel}」订阅已于 ${new Date(locked.expires_at).toLocaleDateString('zh-CN')} 到期，请续费后再授权`
              : `「${planLabel}」的订阅已失效，请重新订阅后再授权`,
        };
      }

      const existing = await devRepo.findOne({
        where: {
          user_id: userId,
          plugin_id: plugin.id,
          device_id: req.device_id,
        },
      });

      if (existing && !existing.revoked_at) {
        // 该设备已授权过：直接放行（重复确认是幂等的），顺手补一下设备名与档位归属。
        // 「改绑档位」不做：已授权的设备归属保持不动，要换档请先解绑再授权
        // （用户明确要求不做改绑入口，避免多一条权限路径）。
        if (req.device_name && !existing.name_custom) existing.device_name = req.device_name;
        if (req.platform) existing.platform = req.platform;
        // 历史行没有归属：顺手补上（只补空值，不覆盖已记录的购买事实）
        if (!existing.subscription_id) existing.subscription_id = chosen.subscription_id;
        await devRepo.save(existing);
        return null;
      }

      // 只统计**本人占用这一档**的设备：团队行由全团共享，额度却是每人一份，
      // 把别人的设备算进来会让第二位成员永远授权不上。
      const used = await devRepo.count({
        where: {
          user_id: userId,
          subscription_id: chosen.subscription_id,
          revoked_at: IsNull(),
        },
      });

      // 走到这里有两种情况：全新设备，或「曾被吊销的同一台设备重新授权」。
      // **两者都会净增一个活跃名额**，所以上限检查必须放在这之前 ——
      // 漏掉这条会出现绕过：吊销 A → 在别的机器授权占满 → A 再来授权，
      // 复用旧行把活跃数顶到 max 之上（曾实测可复现）。
      if (used >= deviceQuotaOfRow(locked)) {
        return {
          reason: 'ACTIVATION_LIMIT',
          message: `「${planLabel}」的 ${deviceQuotaOfRow(locked)} 台设备名额已用满，请解绑一台或改选其他订阅`,
        };
      }

      if (existing) {
        // 复用该行（唯一索引 (user_id, plugin_id, device_id) 保证不会出现重复行）
        existing.revoked_at = null;
        existing.token_hash = null; // 待 poll 阶段签发新令牌
        existing.token_issued_at = null; // 新令牌的绝对有效期从签发时刻重新起算
        existing.subscription_id = chosen.subscription_id;
        // 用户改过名（name_custom）就不覆盖：显式操作不得被后续流程静默回滚
        if (req.device_name && !existing.name_custom) existing.device_name = req.device_name;
        if (req.platform) existing.platform = req.platform;
        await devRepo.save(existing);
      } else {
        await devRepo.save(
          devRepo.create({
            user_id: userId,
            plugin_id: plugin.id,
            device_id: req.device_id,
            device_name: req.device_name || null,
            platform: req.platform || null,
            token_hash: null,
            // 一档一台：设备记住自己占的是哪一档
            subscription_id: chosen.subscription_id,
          }),
        );
      }
      return null;
    });

    if (conflict) {
      // 名额类失败是**可重试**的（换一档 / 解绑一台），不能把请求打成终态 denied：
      // 那会逼用户回插件重新发起一次授权，等于把一次误点放大成一次完整流程。
      if (
        conflict.reason === 'ACTIVATION_LIMIT' ||
        conflict.reason === 'INVALID_SUBSCRIPTION'
      ) {
        throw new BadRequestException(conflict.message);
      }
      return deny(conflict.reason, conflict.message);
    }

    req.status = 'approved';
    req.user_id = userId;
    req.deny_reason = null;
    await this.reqRepo.save(req);

    const after = summarizeQuota(options, await this.countActiveDevices(userId, plugin.id));
    return {
      ok: true,
      status: 'approved',
      expires_at: chosen.expires_at ?? undefined,
      plan: { name: planLabel, slug: chosen.plan_slug },
      devices_used: after.devices_used,
      max_devices: after.max_devices,
    };
  }

  // ─────────────────────────── 设备管理（账户页） ───────────────────────────

  /**
   * 设备 id 归一：把「账号中心卡片上的商品 id」换算成「设备实际挂载的插件 id」。
   *
   * ★ 为什么必须归一（2026-10-28 事故）：
   *   扩展端发起授权时上报的 slug 恒为**主插件**（auth_core.js 的 DEFAULT_SLUG），
   *   所以 `plugin_devices.plugin_id` 永远写的是主插件 id；权益也按主插件族解析。
   *   而 0042「一档一行」之后，账号中心的每张卡片拿的是**用户买的那个商品** id
   *   （trial / -year / -b2b）。不归一时：卡片用商品 id 去查设备 → 恒为 0，
   *   「管理设备」里解绑 / 改名也会 404 —— 用户以为设备被清空、解绑点了没反应。
   *
   * 归一规则与权益判定同源：`root_plugin_id = COALESCE(parent_plugin_id, id)`。
   */
  private async resolveDevicePluginId(pluginId: string): Promise<string> {
    const p = await this.pluginRepo.findOne({ where: { id: pluginId } });
    if (!p) return pluginId;
    return p.parent_plugin_id ?? p.id;
  }

  async listDevices(userId: string, pluginId: string) {
    const rootId = await this.resolveDevicePluginId(pluginId);
    const devices = await this.deviceRepo.find({
      where: { user_id: userId, plugin_id: rootId, revoked_at: IsNull() },
      order: { created_at: 'DESC' },
    });
    /**
     * 上限口径必须与 approve() 逐字一致（同一个 summarizeQuota），
     * 否则界面说「还能再绑 1 台」、实际授权时被拒 —— 这是用户能直接看见的矛盾。
     *
     * 一档一台（0046）后，额度 = 各在期档位额度之和；每台设备还带上「占的是哪一档」，
     * 账号页因此能显示「基础版 1/1 · Pro 1/1」而不是一个笼统的总数。
     */
    const options = await listDeviceTierOptions(this.subRepo.manager, userId, rootId);
    const quota = summarizeQuota(options, devices.length);
    const planNameById = new Map<string, string>();
    for (const o of options) {
      if (o.plan_name) planNameById.set(o.subscription_id, o.plan_name);
    }
    return {
      devices: devices.map((d) => ({
        device_id: d.device_id,
        device_name: d.device_name,
        /** 用户是否手动改过名；前端据此提示「重新授权也不会被覆盖」 */
        name_custom: !!d.name_custom,
        platform: d.platform,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at,
        // 尚未取走令牌 = 已批准但插件没完成激活
        pending: !d.token_hash,
        /** 这台设备占用的订阅档位（0046）；NULL = 历史行，下次重新授权会自动补上 */
        subscription_id: d.subscription_id ?? null,
        plan_name: d.subscription_id
          ? planNameById.get(d.subscription_id) ?? null
          : null,
      })),
      // 没有在期档位时（卡已过期）用实际设备数兜底：避免界面出现「已授权 1/0 台」
      max_devices: quota.max_devices || devices.length,
      used: devices.length,
    };
  }

  /** 吊销单台设备：令牌立即失效，下次启动插件需重新授权 */
  async revokeDevice(userId: string, pluginId: string, deviceId: string) {
    const rootId = await this.resolveDevicePluginId(pluginId);
    const d = await this.deviceRepo.findOne({
      where: { user_id: userId, plugin_id: rootId, device_id: deviceId },
    });
    if (!d) throw new NotFoundException('未找到该设备授权记录');
    if (d.revoked_at) return { ok: true, already: true };
    d.revoked_at = new Date();
    d.token_hash = null; // 立刻失效，不等 token 过期（绝对有效期只是天花板，不是唯一防线）
    d.token_issued_at = null;
    await this.deviceRepo.save(d);
    return { ok: true };
  }

  /** 全清：换机/重装前的粗粒度操作，等价于逐台吊销 */
  async revokeAllDevices(userId: string, pluginId: string) {
    const rootId = await this.resolveDevicePluginId(pluginId);
    await this.deviceRepo.update(
      { user_id: userId, plugin_id: rootId, revoked_at: IsNull() },
      { revoked_at: new Date(), token_hash: null, token_issued_at: null },
    );
    return { ok: true };
  }

  /**
   * 改名一台设备，并打上 name_custom 标记。
   *
   * 为什么需要 name_custom：device_name 是插件端自动上报的（`系统 · 浏览器 · 分辨率 · 时区`），
   * 每次 approve 都会用新值覆盖。用户手动改过的名字如果不做标记，下一次重新授权/续费
   * 就会被冲掉 —— 用户视角是「我起的名字自己变回去了」。标记为 true 后 approve 一律不覆盖。
   *
   * 与 revokeDevice 的差异（有意）：已吊销的行**不**允许改名，直接 404。
   * 列表里看不到已吊销设备，允许改等于开放一个盲写的 id；「查不到就放行/就写」是反模式。
   * 也不校验订阅状态：订阅到期后设备面板仍应可整理，改名无副作用。
   */
  async renameDevice(userId: string, pluginId: string, deviceId: string, name: unknown) {
    const clean = clip(name, DEVICE_NAME_MAX);
    // 空名不做「恢复默认」解释，直接拒：语义不明，且恢复默认需要回读客户端上报值 ——
    // 那个值只在 approve 请求里出现，服务端没留底，做不到。
    if (!clean) throw new BadRequestException('设备名不能为空');

    const rootId = await this.resolveDevicePluginId(pluginId);
    const d = await this.deviceRepo.findOne({
      where: { user_id: userId, plugin_id: rootId, device_id: deviceId },
    });
    if (!d || d.revoked_at) throw new NotFoundException('未找到该设备授权记录');

    d.device_name = clean;
    d.name_custom = true;
    await this.deviceRepo.save(d);
    return { ok: true, device_id: d.device_id, device_name: d.device_name, name_custom: true };
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private countActiveDevices(userId: string, pluginId: string): Promise<number> {
    return this.deviceRepo.count({
      where: { user_id: userId, plugin_id: pluginId, revoked_at: IsNull() },
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
