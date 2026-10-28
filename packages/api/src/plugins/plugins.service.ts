import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Not, Repository } from 'typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { User } from '../auth/user.entity';
import { ensureOwnerTeam } from '../teams/ensure-owner-team';
import { PluginDevice } from './plugin-auth.entity';
import { isSubscriptionEntitled } from './plugin-auth.util';
import {
  OrdersService,
  MAIN_PLUGIN_SLUG,
  mergeSeatsFloor,
  isTierLikePlugin,
  tierOfPlugin,
  resolveEntitlementParent,
} from '../payments/orders.service';
import { OssService } from '../storage/oss.service';

/**
 * 公开接口（未登录可访问）允许看到的插件字段。
 *
 * 剥离 `download_key` / `download_filename`：前者是 OSS 对象 key，本身不是下载
 * 凭证（下载一律走 GET /plugins/:id/download 由服务端签名），但泄露它等于把文件
 * 组织方式交出去 —— 一旦桶策略被误改为公开读，就变成免费分发通道。
 * 后台接口（admin/plugins）走 adminList/adminGet，不经过本类型，字段照旧返回。
 */
export type PublicPlugin = Omit<Plugin, 'download_key' | 'download_filename'>;

@Injectable()
export class PluginsService {
  constructor(
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
    @InjectRepository(PluginSubscription)
    private readonly subRepo: Repository<PluginSubscription>,
    @InjectRepository(PluginDevice)
    private readonly deviceRepo: Repository<PluginDevice>,
    private readonly orders: OrdersService,
    private readonly oss: OssService,
  ) {}

  /**
   * 剥离公开接口不该出现的字段。改这里前先确认前端没在读被剥掉的字段
   * （下载链接在网页端由 GET /plugins/:id/download 现取）。
   */
  private stripPublic(p: Plugin): PublicPlugin {
    const rest: any = { ...p };
    delete rest.download_key;
    delete rest.download_filename;
    return rest as PublicPlugin;
  }

  /** 公开列表（上架中，按排序） */
  async list(): Promise<PublicPlugin[]> {
    const rows = await this.pluginRepo.find({
      where: { status: 'active' },
      order: { sort_order: 'ASC', created_at: 'ASC' },
    });
    return rows.map((p) => this.stripPublic(p));
  }

  async getBySlug(slug: string): Promise<PublicPlugin | null> {
    const p = await this.pluginRepo.findOne({
      where: { slug, status: 'active' },
    });
    return p ? this.stripPublic(p) : null;
  }

  /** 我的订阅（纯订阅记录，插件详情由前端用 /plugins 列表合并） */
  /** 过期收敛的节流时间戳（ms） */
  private lastExpireSweepAt = 0;

  /**
   * 把「status='active' 但 expires_at 已过」的订阅行收敛为 'expired'。
   *
   * ── 为什么需要 ────────────────────────────────────────────────────────
   * 判权 `isSubscriptionEntitled()` 同时看 status 与 expires_at，所以**权益从不出错**；
   * 但**显示与筛选只看 status** —— 后台订阅列表于是出现「状态=生效中 + 到期时间已过」
   * （还挂着「已过期待同步」小字），按「已过期」筛选又会漏掉这批人。
   * 平台没有自动续费，到期后状态理应就是 expired，不该长期停在 active。
   *
   * ── 为什么惰性而不是定时任务 ──────────────────────────────────────────
   * 项目现有风格是 setInterval / 惰性（见 orders.service.ts 的补偿任务），不引入
   * @nestjs/schedule。查订阅必经这两个读方法，故收敛一定被触发，不依赖进程常驻时长；
   * 60s 节流保证不是每个请求都写库（条件幂等，第二次起影响 0 行）。
   *
   * ── 为什么不动 cancelled ──────────────────────────────────────────────
   * `cancelled` 的语义是「用户主动取消、权益到本周期结束」，与自然到期不同，
   * 它到期后由同一判权函数识别为无权，但状态本身应保留以便追溯。
   *
   * ── 对续费无影响 ──────────────────────────────────────────────────────
   * 发放/续期查找 existing 时**不带 status 条件**（orders.service.ts、adminAdd），
   * 顺延与否只由 `isSubscriptionEntitled(existing)` 决定 —— 已收回的行会正确地
   * 从今天重新起算，不会被当成「仍在有效期内」而多送一个周期。
   */
  private async sweepExpiredSubscriptions(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastExpireSweepAt < 60_000) return;
    this.lastExpireSweepAt = nowMs;
    try {
      await this.subRepo.query(
        `UPDATE plugin_subscriptions
            SET status = 'expired'
          WHERE status = 'active'
            AND expires_at <= now()`,
      );
    } catch {
      // 收敛失败不能拖垮查询：显示层已按判权口径兜底（SubscriptionsPanel），
      // 且下次读请求（≥60s 后）会重试，单次失败不影响最终一致性。
    }
  }

  async mySubscriptions(userId: string): Promise<PluginSubscription[]> {
    // 席位制（0035）：除本人订阅外，还要带出「所在团队的有效覆盖行」——否则成员在
    // 市场页/账号页看到的是「订阅」按钮，点进去重复付费（与 b2b tier 映射同坑）。
    // 每行附带 via_team / is_team_owner / team_name，前端据此渲染：
    //   团长 → 「团队版」徽标 + 团名 + 「管理团队」入口；成员 → 「由团队提供」徽标。
    //
    // 0042（一档一行，2026-10-28）：**不再做任何去重折叠**。
    //   一行 = 用户真实买过的一个商品，账号中心据此「一档一张卡」，到期也保留。
    //   旧实现（0041）按商品族折叠是为了掩盖归档行重复，那是旧模型的症状；
    //   新模型下同一商品只可能有 1 条个人行（唯一索引保证），折叠反而会吞掉用户
    //   买过的档位 —— 正是用户反馈「我的基础版不见了」的根因。
    await this.sweepExpiredSubscriptions();
    const rows: any[] = await this.subRepo.query(
      `SELECT s.*,
              (s.team_id IS NOT NULL) AS via_team,
              (s.team_id IS NOT NULL AND s.user_id = $1) AS is_team_owner,
              t.name AS team_name
         FROM plugin_subscriptions s
         LEFT JOIN teams t ON t.id = s.team_id
        WHERE s.user_id = $1
           OR (s.team_id IS NOT NULL AND s.status IN ('active', 'cancelled') AND s.expires_at > now()
               AND EXISTS (
                     SELECT 1 FROM team_members m
                      WHERE m.team_id = s.team_id AND m.user_id = $1))
        ORDER BY s.started_at DESC`,
      [userId],
    );
    return rows as PluginSubscription[];
  }

  /**
   * 我的「限购名额」快照（0041）：市场页据此把已达上限的商品卡片置灰、按钮改「已领取」。
   *
   * 只返回**配置了上限**的商品，不把全量商品 id 塞给前端。
   * 统计口径与下单拦截（orders.countPaidPluginPurchases）逐字一致：
   * PAID/DELIVERED 且未退款，COUNT(DISTINCT o.id)。
   * 口径一旦不一致就会出现「卡片说还能买、点下单被拒」的矛盾。
   */
  async purchaseLimits(
    userId: string,
  ): Promise<Record<string, { used: number; limit: number; exhausted: boolean }>> {
    const limited = await this.pluginRepo.find({
      where: { status: 'active', max_purchases_per_user: Not(IsNull()) },
    });
    if (!limited.length) return {};

    const rows: any[] = await this.subRepo.manager.query(
      `SELECT i.subject_id AS plugin_id, COUNT(DISTINCT o.id) AS c
         FROM orders o
         JOIN order_items i ON i.order_id = o.id
        WHERE o.user_id = $1
          AND i.subject_type = 'plugin'
          AND i.subject_id = ANY($2::uuid[])
          AND o.status IN ('PAID','DELIVERED')
          AND COALESCE(o.refunded_cents, 0) = 0
        GROUP BY i.subject_id`,
      [userId, limited.map((p) => p.id)],
    );
    const used: Record<string, number> = {};
    for (const r of rows) used[String(r.plugin_id)] = Number(r.c ?? 0);

    const out: Record<string, { used: number; limit: number; exhausted: boolean }> = {};
    for (const p of limited) {
      const u = used[p.id] ?? 0;
      const limit = Number(p.max_purchases_per_user);
      out[p.id] = { used: u, limit, exhausted: u >= limit };
    }
    return out;
  }

  /** 订阅下单（包月，微信 Native） */
  async subscribe(userId: string, pluginId: string) {
    const plugin = await this.pluginRepo.findOne({ where: { id: pluginId } });
    if (!plugin || plugin.status !== 'active') {
      throw new NotFoundException('插件不存在或未上架');
    }
    // 复用现有下单 + 微信支付，order.type='plugin'
    return this.orders.createOrder(userId, {
      type: 'plugin',
      pluginId,
      tradeType: 'NATIVE',
    });
  }

  /** 生成签名下载 URL（免费下载；复用 OSS 签名，不暴露桶路径与原始响应头） */
  async signDownload(pluginId: string) {
    /** 2026-09-27 修正：下架后仍允许已购用户下载安装包。 */
    let plugin = await this.pluginRepo.findOne({ where: { id: pluginId } });
    if (!plugin) {
      throw new NotFoundException('插件不存在');
    }
    /**
     * 企业版档位商品（alibaba-toolkit-b2b）的权益实体在主插件行（见
     * orders.service.ts fulfillPluginSubscription 的映射），安装包也和主插件是同一个。
     * b2b 商品没单独配 download_key 时回退主插件的，避免已购企业版用户点下载报
     * 「暂未配置下载文件」。
     */
    if (!plugin.download_key && isTierLikePlugin(plugin)) {
      // 0041：显式 parent_plugin_id 优先，slug 前缀兜底（试用商品的 slug 曾被填成
      // `7testing` 这类无前缀值，前缀判据会漏）
      const main = await resolveEntitlementParent(this.pluginRepo, plugin);
      if (main?.download_key) plugin = main;
    }
    if (!plugin.download_key) {
      throw new BadRequestException('该插件暂未配置下载文件');
    }
    const rawName = plugin.download_filename || `${plugin.name}.zip`;
    const asciiName =
      rawName.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'plugin.zip';
    const encodedName = encodeURIComponent(rawName);
    const dispValue = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
    const url = await this.oss.signDownloadWithDisposition(
      plugin.download_key,
      dispValue,
    );
    if (!url) throw new BadRequestException('下载服务未配置');
    return { url };
  }

  /**
   * 取消订阅 = **标记「到期不再续费」**，不是立即失效，也不退款。
   *
   * 2026-09-26 语义修正：`cancelled` 只是「不再续费」的标记，权益判定统一走
   * `isSubscriptionEntitled`（active / cancelled 且未到期 → 仍有权）。在此之前
   * 权益判定里写的是 `status !== 'active'`，于是用户点一下取消就当场销毁了已付费的
   * 剩余天数 —— 而前端 cancelConfirm 的文案一直承诺「本期仍可使用」，实现与文案对着干。
   * 本方法本身无需改动（只翻标记），改动在权益判定侧。
   */
  async cancel(userId: string, pluginId: string) {
    // ⚠️ 只取消**个人订阅行**（team_id IS NULL，2026-10-12 质检）：0035 之后同一用户
    // 可同时持有个人行+团队行，旧实现不带条件 findOne，PG 不保证返回行序——
    // 可能把团队行置 cancelled（全团被标「到期不再续费」）。
    const sub = await this.subRepo.findOne({
      where: { user_id: userId, plugin_id: pluginId, team_id: IsNull() },
    });
    // 二轮质检 #10：双行用户调 cancel 只会命中个人行；只持团队行的团长会走到这。
    // 文案说清楚，避免用户以为「按钮点了没用」。
    if (!sub) throw new NotFoundException('未找到个人订阅记录（团队订阅请联系管理员调整）');
    if (sub.status === 'cancelled') return sub;   // 幂等：重复点不再写库
    sub.status = 'cancelled';
    return this.subRepo.save(sub);
  }

  // 设备授权相关（校验/审批/吊销）全部在 PluginsAuthService，本服务不管凭证。

  // ─────────────────────── 后台上架管理（AdminGuard 保护） ───────────────────────

  /**
   * 后台列表：含下架，按排序。
   * 额外附带 `user_count` = 该插件「已授权设备」口径的去重用户数
   * （plugin_devices 中 revoked_at IS NULL，按 user_id 去重）。
   */
  async adminList(): Promise<Array<Plugin & { user_count: number }>> {
    const [plugins, counts] = await Promise.all([
      this.pluginRepo.find({ order: { sort_order: 'ASC', created_at: 'ASC' } }),
      this.userCounts(),
    ]);
    return plugins.map((p) => ({ ...p, user_count: counts[p.id] ?? 0 }));
  }

  /**
   * 各插件的「使用用户数」聚合（一次 GROUP BY 全量算完，避免 N+1）。
   * 口径与后台列表「用户数」列、以及 :id/users 弹窗完全一致：
   * plugin_devices 中 revoked_at IS NULL，按 user_id 去重。
   *
   * ⚠️ 用原始 SQL 片段 `.where('d.revoked_at IS NULL')` —— 不要用 `where: { revoked_at: null }`
   * 对象写法（TypeORM 0.3 默认会把裸 null 条件静默丢弃，见项目 memory）。
   */
  private async userCounts(): Promise<Record<string, number>> {
    const rows = await this.deviceRepo
      .createQueryBuilder('d')
      .select('d.plugin_id', 'plugin_id')
      .addSelect('COUNT(DISTINCT d.user_id)', 'cnt')
      .where('d.revoked_at IS NULL')
      .groupBy('d.plugin_id')
      .getRawMany();
    const map: Record<string, number> = {};
    for (const r of rows) map[r.plugin_id] = Number(r.cnt) || 0;
    return map;
  }

  /**
   * 后台：某插件的「使用用户」列表（distinct 已授权设备用户，join users 取邮箱/昵称）。
   *
   * 口径与列表页「用户数」列一致：plugin_devices 中 revoked_at IS NULL，按 user_id 去重；
   * 一个用户可能有多台设备，这里聚合成一行：
   *   · start_date  = 该用户最早一次设备授权 created_at（首次开始使用）
   *   · recent_date = 该用户最近活跃 last_seen_at（未上报过则为 NULL，前端显示「—」）
   *
   * 复用 adminListSubscriptions 的写法：devices 表用构造函数注入的 deviceRepo，
   * users 走 `leftJoin(User, ...)`（与订阅列表同构，避免往 module ENTITIES 加 User 触发 502）。
   */
  async adminListUsers(pluginId: string, q: any) {
    await this.adminGet(pluginId); // 插件不存在 → 直接 404

    const page = Math.max(1, Math.floor(Number(q?.page) || 1));
    const size = Math.min(200, Math.max(1, Math.floor(Number(q?.size) || 50)));
    const search = String(q?.search ?? '').trim();

    // items 与 total 必须走**完全相同**的 where，否则分页数会对不上
    const apply = (qb: any) => {
      qb.where('d.plugin_id = :pluginId', { pluginId }).andWhere('d.revoked_at IS NULL');
      if (search) {
        qb.andWhere('(u.email ILIKE :kw OR u.name ILIKE :kw)', { kw: `%${search}%` });
      }
      return qb;
    };

    const items = await apply(
      this.deviceRepo.createQueryBuilder('d').leftJoin(User, 'u', 'u.id = d.user_id'),
    )
      .select([
        'd.user_id AS user_id',
        'u.email AS user_email',
        'u.name AS user_name',
        'MIN(d.created_at) AS start_date',
        'MAX(d.last_seen_at) AS recent_date',
      ])
      .groupBy('d.user_id')
      .addGroupBy('u.email')
      .addGroupBy('u.name')
      .orderBy('recent_date', 'DESC', 'NULLS LAST')
      .offset((page - 1) * size)
      .limit(size)
      .getRawMany();

    const totalRow = await apply(
      this.deviceRepo.createQueryBuilder('d').leftJoin(User, 'u', 'u.id = d.user_id'),
    )
      .select('COUNT(DISTINCT d.user_id)', 'c')
      .getRawOne();

    return { items, total: Number(totalRow?.c ?? 0), page, size };
  }

  /** 后台详情（含下架），未找到抛 404 */
  async adminGet(id: string): Promise<Plugin> {
    const plugin = await this.pluginRepo.findOne({ where: { id } });
    if (!plugin) throw new NotFoundException('插件不存在');
    return plugin;
  }

  /**
   * 新增插件。name 必填；slug 缺省时自动生成。
   * 可编辑字段与实体一一对应；价格按「分」传入（前端元→分换算）。
   */
  async adminCreate(body: any): Promise<Plugin> {
    const name = (body?.name || '').trim();
    if (!name) throw new BadRequestException('名称必填');
    let slug = (body?.slug || '').trim().toLowerCase();
    if (!slug) slug = this.genSlug(name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw new BadRequestException('slug 仅允许小写字母/数字/连字符，长度 1-64');
    }
    const exists = await this.pluginRepo.findOne({ where: { slug } });
    if (exists) throw new ConflictException('slug 已存在');

    /**
     * 商品类型与档位归属（0041，2026-10-28 事故后的强制约束）。
     *
     * 事故：运营建「新用户试用」时 slug 填了 `7testing`，权益映射靠 slug 前缀判定 →
     * 不认 → 订阅落在试用行 → 扩展端按主行查不到 → 用户买了用不了。
     * 现在改为显式 `parent_plugin_id`，且 kind 为 tier/trial 时**必须**有归属，
     * 不再允许「靠命名约定碰运气」。
     */
    const kind = this.normalizeKind(body?.kind);
    const parentId = await this.resolveParentInput(body?.parent_plugin_id, kind, slug);
    // 试用默认值：每人 1 次、不可续费（后台仍可显式覆盖）
    const defaultLimit = kind === 'trial' ? 1 : null;
    const defaultRenew = kind !== 'trial';

    const plugin = this.pluginRepo.create({
      slug,
      name,
      tagline: body?.tagline ?? null,
      description: body?.description ?? null,
      icon_url: body?.icon_url ?? null,
      category: (body?.category || '通用').trim() || '通用',
      price_monthly_cents: this.normalizePrice(body?.price_monthly_cents),
      list_price_monthly_cents: this.normalizeListPrice(
        body?.list_price_monthly_cents,
      ),
      promo_ends_at: this.normalizePromoEnds(body?.promo_ends_at),
      features: this.normalizeFeatures(body?.features),
      currency: body?.currency || 'CNY',
      status: body?.status === 'hidden' ? 'hidden' : 'active',
      sort_order: Number(body?.sort_order) || 0,
      max_activations: this.normalizeActivations(body?.max_activations),
      subscription_duration_days: this.normalizeDuration(body?.subscription_duration_days),
      kind,
      parent_plugin_id: parentId,
      max_purchases_per_user:
        body?.max_purchases_per_user === undefined
          ? defaultLimit
          : this.normalizePurchaseLimit(body.max_purchases_per_user),
      renew_allowed: this.normalizeRenewAllowed(body?.renew_allowed, defaultRenew),
      download_key: body?.download_key ?? null,
      download_filename: body?.download_filename ?? null,
      owner_team_id: body?.owner_team_id || null,
    });
    return this.pluginRepo.save(plugin);
  }

  /** 更新插件（部分字段；未传字段保持原值）。 */
  async adminUpdate(id: string, body: any): Promise<Plugin> {
    const plugin = await this.adminGet(id);

    const textFields: (keyof Plugin)[] = [
      'name',
      'tagline',
      'description',
      'icon_url',
      'download_key',
      'download_filename',
    ];
    for (const f of textFields) {
      if (body?.[f] !== undefined) (plugin as any)[f] = body[f] || null;
    }
    if (body?.name !== undefined && !String(body.name).trim()) {
      throw new BadRequestException('名称不能为空');
    }
    // category / currency 是 NOT NULL 列：清空时回落默认值，避免直接置 null 触发 500
    if (body?.category !== undefined) {
      plugin.category = String(body.category || '').trim() || '通用';
    }
    if (body?.currency !== undefined) {
      plugin.currency = String(body.currency || '').trim() || 'CNY';
    }
    if (body?.status !== undefined) {
      plugin.status = body.status === 'active' ? 'active' : 'hidden';
    }
    if (body?.sort_order !== undefined) plugin.sort_order = Number(body.sort_order) || 0;
    if (body?.max_activations !== undefined) {
      plugin.max_activations = this.normalizeActivations(body.max_activations);
    }
    if (body?.subscription_duration_days !== undefined) {
      plugin.subscription_duration_days = this.normalizeDuration(body.subscription_duration_days);
    }
    /**
     * 商品类型 / 档位归属 / 限购 / 续费（0041）。
     * 切到 trial 时补默认值（限购 1 次、不可续费）；显式传了就尊重显式值。
     */
    if (body?.kind !== undefined) {
      plugin.kind = this.normalizeKind(body.kind);
      if (plugin.kind === 'trial') {
        if (body?.max_purchases_per_user === undefined && plugin.max_purchases_per_user == null) {
          plugin.max_purchases_per_user = 1;
        }
        if (body?.renew_allowed === undefined) plugin.renew_allowed = false;
      }
    }
    if (body?.parent_plugin_id !== undefined) {
      plugin.parent_plugin_id = await this.resolveParentInput(
        body.parent_plugin_id,
        plugin.kind || 'standard',
        plugin.slug,
      );
    }
    if (body?.max_purchases_per_user !== undefined) {
      plugin.max_purchases_per_user = this.normalizePurchaseLimit(body.max_purchases_per_user);
    }
    if (body?.renew_allowed !== undefined) {
      plugin.renew_allowed = this.normalizeRenewAllowed(body.renew_allowed, true);
    }
    if (body?.price_monthly_cents !== undefined) {
      plugin.price_monthly_cents = this.normalizePrice(body.price_monthly_cents);
    }
    if (body?.list_price_monthly_cents !== undefined) {
      plugin.list_price_monthly_cents = this.normalizeListPrice(
        body.list_price_monthly_cents,
      );
    }
    if (body?.promo_ends_at !== undefined) {
      plugin.promo_ends_at = this.normalizePromoEnds(body.promo_ends_at);
    }
    if (body?.features !== undefined) {
      plugin.features = this.normalizeFeatures(body.features);
    }
    if (body?.owner_team_id !== undefined) plugin.owner_team_id = body.owner_team_id || null;

    if (body?.slug !== undefined) {
      const next = String(body.slug).trim().toLowerCase();
      if (next && next !== plugin.slug) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(next)) {
          throw new BadRequestException('slug 格式不合法');
        }
        const dup = await this.pluginRepo.findOne({ where: { slug: next } });
        if (dup) throw new ConflictException('slug 已存在');
        plugin.slug = next;
      }
    }
    return this.pluginRepo.save(plugin);
  }

  /**
   * 删除插件。已有订阅或设备授权记录时拒绝（避免记录悬挂指向不存在的插件），
   * 提示改用「下架」（status=hidden）。
   */
  async adminRemove(id: string): Promise<{ ok: boolean; message?: string }> {
    const plugin = await this.adminGet(id);
    const subs = await this.subRepo.count({ where: { plugin_id: id } });
    if (subs > 0) {
      throw new ConflictException(
        `该插件已有 ${subs} 条订阅记录，无法删除；请改为「下架」（status=hidden）`,
      );
    }
    const devices = await this.deviceRepo.count({ where: { plugin_id: id } });
    if (devices > 0) {
      throw new ConflictException(
        `该插件已有 ${devices} 条设备授权记录，无法删除；请改为「下架」（status=hidden）`,
      );
    }
    await this.pluginRepo.remove(plugin);
    return { ok: true };
  }

  /* ==================== 后台：订阅管理 ==================== */

  /** 订阅状态白名单（与实体注释 active/expired/cancelled 逐字一致） */
  private static readonly SUB_STATUSES: readonly string[] = ['active', 'expired', 'cancelled'];

  /** 单个订阅最长时长上限（天）—— 防止手滑把 30 打成 30000 变成永久授权 */
  private static readonly MAX_SUB_DAYS = 3650;

  /**
   * 解析到期时间参数：
   *   · 显式给 `expires_at` → 用它（**覆盖**语义）
   *   · 只给 `days` → 由调用方按「顺延基点 + N 天」算（**顺延**语义）
   *
   * 纯日期串（YYYY-MM-DD）按**东八区当天 23:59:59**解释 —— 否则 new Date('2026-12-31')
   * 落到 UTC 00:00，在北京时间当天 08:00 就失效了，用户会看到「选到 31 号却提前一天过期」。
   */
  private parseExpiryInput(body: any): { expiresAt: Date | null; days: number } {
    let expiresAt: Date | null = null;
    const raw = body?.expires_at;
    if (raw !== undefined && raw !== null && raw !== '') {
      const s = String(raw).trim();
      const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
        ? new Date(`${s}T23:59:59+08:00`)
        : new Date(s);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('到期时间格式不正确');
      expiresAt = d;
    }

    const days = Math.floor(Number(body?.days));
    if (!expiresAt) {
      if (!Number.isFinite(days) || days <= 0) {
        throw new BadRequestException('请提供天数（days）或到期时间（expires_at）');
      }
      if (days > PluginsService.MAX_SUB_DAYS) {
        throw new BadRequestException(`天数上限 ${PluginsService.MAX_SUB_DAYS} 天`);
      }
    }
    return { expiresAt, days: Number.isFinite(days) && days > 0 ? days : 0 };
  }

  /**
   * 解析订阅状态参数（缺省时回退 fallback）。
   *
   * 新增与编辑共用，保证两个入口的白名单、报错文案完全一致 —— 分开写必然漂移。
   * ⚠️ 非 active 一律会被 entitlement 判为不可用（返回 SUBSCRIPTION_EXPIRED，
   *    客户端保留令牌），所以「已过期」与「已取消」在拦截效果上等价，只是语义标签不同。
   */
  private parseStatusInput(body: any, fallback: string): string {
    const raw = body?.status;
    if (raw === undefined || raw === null || raw === '') return fallback;
    const s = String(raw).trim();
    if (!PluginsService.SUB_STATUSES.includes(s)) {
      throw new BadRequestException(`状态只能是 ${PluginsService.SUB_STATUSES.join(' / ')}`);
    }
    return s;
  }

  /** 订阅类型白名单（0031）：personal=个人版 / team=团队版。仅档位标注，不参与判权。 */
  private static readonly SUB_TIERS = ['personal', 'team'];

  /** 与 parseStatusInput 同构：未传回退 fallback，非法报 400（新增/编辑两入口共用防漂移） */
  private parseTierInput(body: any, fallback: string): string {
    const raw = body?.tier;
    if (raw === undefined || raw === null || raw === '') return fallback;
    const s = String(raw).trim();
    if (!PluginsService.SUB_TIERS.includes(s)) {
      throw new BadRequestException(`订阅类型只能是 ${PluginsService.SUB_TIERS.join(' / ')}`);
    }
    return s;
  }

  /**
   * 后台：某插件的订阅列表（join users 取邮箱/昵称）。
   *
   * 用 `manager.getRepository(User)` 而不是构造函数注入 —— 注入就要往
   * plugins.module.ts 的 ENTITIES 里加 User，漏一处就是 api 502（本项目踩过）。
   */
  async adminListSubscriptions(pluginId: string, q: any) {
    // 仅用于校验商品存在（不存在时 adminGet 抛 404），返回值本方法不再使用
    await this.adminGet(pluginId);
    // 先收敛过期行，否则「状态」筛选会把实际已到期的人算进「生效中」
    await this.sweepExpiredSubscriptions();

    // 归属映射（0042，一档一行）：**恒按所购商品精确匹配** `plugin_id`。
    //
    // ⚠️ 2026-10-28 修正（用户实测反馈）：初版让「主插件页」按 `root_plugin_id` 汇总
    //    该插件的**全部档位**订阅，本意是给运营一个总览，结果观感是重复 ——
    //    买「Team 专业版」的王祭司同时出现在「基础版」列表和「Team 专业版」列表里，
    //    运营无法判断他到底买的是哪一档。
    //    一档一行的直觉就是「打开哪个商品，只看买了这个商品的人」，故取消汇总：
    //      基础版页 → 只有 plugin_id = 基础版 的人
    //      专业版页 → 只有 plugin_id = -b2b 的人
    //    想看全量用主插件的「全部状态」+ 搜索，不要靠 root 汇总。
    const wherePluginId = pluginId;

    const page = Math.max(1, Math.floor(Number(q?.page) || 1));
    const size = Math.min(100, Math.max(1, Math.floor(Number(q?.size) || 20)));
    const search = String(q?.search ?? '').trim();
    const status = String(q?.status ?? '').trim();

    // 把过滤条件抽成函数：items 与 total 必须走**完全相同**的 where，否则分页数会对不上
    const applyFilters = (qb: any) => {
      qb.where('s.plugin_id = :pluginId', { pluginId: wherePluginId });
      // 0042：不再按 tier 拆个人/团队两个桶。
      // 站在商品维度，买了它的人（个人行或团队行）都该出现；列表已带 team_name 列，
      // 运营一眼能分辨。旧实现把个人桶收紧为 team_id IS NULL，会让团队行在商品页消失。
      if (status) qb.andWhere('s.status = :status', { status });
      if (search) qb.andWhere('(u.email ILIKE :kw OR u.name ILIKE :kw)', { kw: `%${search}%` });
      return qb;
    };

    const items = await applyFilters(
      this.subRepo
        .createQueryBuilder('s')
        .leftJoin(User, 'u', 'u.id = s.user_id')
        .leftJoin('teams', 't', 't.id = s.team_id'),
    )
      .select([
        's.id AS id',
        's.user_id AS user_id',
        's.plugin_id AS plugin_id',
        's.plan AS plan',
        's.tier AS tier',
        's.status AS status',
        's.price_cents AS price_cents',
        's.started_at AS started_at',
        's.expires_at AS expires_at',
        's.order_id AS order_id',
        's.team_id AS team_id',
        's.seats AS seats',
        's.max_devices_per_member AS max_devices_per_member',
        's.root_plugin_id AS root_plugin_id',
        'u.email AS user_email',
        'u.name AS user_name',
        't.name AS team_name',
      ])
      .orderBy('s.expires_at', 'DESC')
      .offset((page - 1) * size)
      .limit(size)
      .getRawMany();

    const total = await applyFilters(
      this.subRepo.createQueryBuilder('s').leftJoin(User, 'u', 'u.id = s.user_id'),
    ).getCount();

    return { items, total, page, size };
  }

  /**
   * 后台：手动添加 / 续期订阅。
   *
   * 语义与付费路径（orders.fulfillPluginSubscription）**刻意保持一致**：
   *   已有生效中的订阅 → 顺延；否则从现在起算。
   * 差别只在「不产生订单」：新建时 order_id=null、price_cents=0，天然与付费记录可区分，
   * **因此不需要加列、不需要跑迁移**。
   *
   * 已存在的记录**不覆盖 order_id / price_cents / started_at** —— 如果这本来是一笔
   * 付费订阅，手动续期只该延长它的有效期，不该抹掉它的财务溯源。
   */
  async adminAddSubscription(pluginId: string, body: any): Promise<PluginSubscription> {
    const plugin = await this.adminGet(pluginId);

    // 0042（一档一行）：后台在哪款商品页手动开通，就落**哪款商品**一行；
    // 权益归属 root_plugin_id 由其 parent 决定。旧实现把行落到主插件上，
    // 于是后台给「Pro 标准版」开通，用户账号页却显示「基础版」。
    let rootPluginId = pluginId;
    if (isTierLikePlugin(plugin)) {
      const main = await resolveEntitlementParent(this.pluginRepo, plugin);
      if (!main) {
        throw new BadRequestException(
          '档位/试用商品配置异常：找不到其归属的主插件行，已拒绝开通',
        );
      }
      rootPluginId = main.id;
    }

    const userId = String(body?.user_id ?? '').trim();
    if (!userId) throw new BadRequestException('请选择要授权的用户');

    const user = await this.subRepo.manager.getRepository(User).findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('用户不存在');

    const { expiresAt, days } = this.parseExpiryInput(body);
    // 状态默认 active（新增/编辑弹窗的默认值也是它）；显式传入才覆盖
    const status = this.parseStatusInput(body, 'active');
    const DAY = 86400_000;
    const now = Date.now();

    // 席位制（0035）：tier=team 时自动建团（购买者/被授权者=团长），订阅行挂 team_id。
    // 与支付回调（orders.fulfillPluginSubscription）走同一个 ensureOwnerTeam，两条路径行为一致。
    const tier = this.parseTierInput(body, 'personal');
    let teamId: string | null = null;
    let seats: number | null = null;
    let maxPerMember: number | null = null;
    if (tier === 'team') {
      const team = await ensureOwnerTeam(this.subRepo.manager, userId, body?.team_name);
      teamId = team.id;
      seats = this.normalizeSeats(body?.seats, plugin.team_seats ?? 3);
      maxPerMember = this.normalizeSeats(body?.max_devices_per_member, 1);
    }

    // 顺延查找按行类型隔离：团队行与个人行互不干扰（同一用户可同时持有）
    const existing = await this.subRepo.findOne({
      where:
        tier === 'team'
          ? { user_id: userId, plugin_id: pluginId, team_id: Not(IsNull()) }
          : { user_id: userId, plugin_id: pluginId, team_id: IsNull() },
    });

    if (existing) {
      // 顺延基点：仍有权（active / cancelled 且未到期）就从原到期日往后加，已失效才从现在起算。
      // 与 orders.fulfillPluginSubscription 用同一个判据，避免两条路径对同一个用户给出不同到期日。
      const stillActive = isSubscriptionEntitled(existing, now);
      if (expiresAt) {
        existing.expires_at = expiresAt;
      } else {
        // 顺延基点：还生效就从原到期日往后加，已失效就从现在起算
        const base = stillActive ? existing.expires_at.getTime() : now;
        existing.expires_at = new Date(base + days * DAY);
      }
      existing.status = status;
      existing.tier = tier;
      existing.root_plugin_id = rootPluginId;
      if (tier === 'team') {
        existing.team_id = teamId;
        // 席位上取（2026-10-12 四轮质检）：新增/续期弹窗的席位初值恒为商品档位默认值，
        // 旧实现无条件覆盖 → 运营手工加过席位的团，一次续期就被打回默认值
        // （付费用户被降配，后续邀请被 assertSeatAvailable 拦下）。降席只能走编辑弹窗。
        existing.seats = mergeSeatsFloor(existing.seats, seats);
        existing.max_devices_per_member = mergeSeatsFloor(
          existing.max_devices_per_member,
          maxPerMember,
        );
      }
      await this.subRepo.save(existing);
      return existing;
    }

    // ⚠️ 这里**不要**给对象加 `as any`：TypeORM 的 create() 有「数组」重载，
    //    传 any 会让 TS 命中数组签名，返回类型变成 PluginSubscription[]（本轮踩到）。
    //    order_id 刻意不传 → 落库为 NULL，这就是「非付费」的天然标记。
    const sub = this.subRepo.create({
      user_id: userId,
      plugin_id: pluginId,
      root_plugin_id: rootPluginId,
      plan: 'manual',
      tier,
      team_id: teamId,
      seats,
      max_devices_per_member: maxPerMember,
      price_cents: 0,
      status,
      started_at: new Date(),
      expires_at: expiresAt ?? new Date(now + days * DAY),
    });
    await this.subRepo.save(sub);
    return sub;
  }

  /**
   * 后台：精确修改某条订阅的到期时间 / 状态。
   *
   * ⚠️ 必须校验「这条订阅属于路由上的那个插件」。旧实现只用 `sid` 定位，路由里的 `id`
   * 完全没参与 —— 于是拿 A 插件的 id 去改 B 插件的订阅，操作会成功，但审计日志用 `id`
   * 作 target_id，**日志会记成「改了 A」**。没有横向提权（接口本身是管理员限定），
   * 但审计不可信 = 出事时查不出是谁动的。宁可直接拒绝。
   */
  async adminUpdateSubscription(
    pluginId: string,
    subId: string,
    body: any,
  ): Promise<PluginSubscription> {
    const plugin = await this.adminGet(pluginId);
    // 0042：一档一行后，编辑权限的判据是「这条订阅是否本商品（或本插件的某个档位）」。
    // 在主插件页可编辑该插件的全部档位行；在具体商品页只可编辑本商品的行。
    const isMainPage = plugin.slug === MAIN_PLUGIN_SLUG && !isTierLikePlugin(plugin);

    const sub = await this.subRepo.findOne({ where: { id: subId } });
    if (!sub) throw new NotFoundException('订阅记录不存在');
    if (isMainPage ? sub.root_plugin_id !== pluginId : sub.plugin_id !== pluginId) {
      throw new BadRequestException('该订阅不属于当前插件，请刷新后重试');
    }

    if (body?.expires_at !== undefined && body?.expires_at !== null && body?.expires_at !== '') {
      const { expiresAt } = this.parseExpiryInput({ expires_at: body.expires_at });
      sub.expires_at = expiresAt as Date;
    }
    if (body?.status !== undefined) {
      // 复用同一个解析器：白名单与报错文案与新增入口保持一致
      sub.status = this.parseStatusInput(body, sub.status);
    }

    /**
     * tier 只解析一次，全流程用同一个归一化值（2026-10-12 四轮质检）。
     * 旧实现「写 sub.tier 用 parseTierInput，判是否建团却用原始 body.tier」——
     * 传 `' team '`（带空白）时 parseTierInput 通过并 trim 成 'team'，但
     * `' team ' === 'team'` 为 false → 行被标成 tier=team 却没有 team_id，
     * 权益解析走个人分支 → 「团队版」实际只有团长一人能用。
     */
    const nextTier =
      body?.tier !== undefined
        ? this.parseTierInput(body, sub.tier || 'personal')
        : sub.tier || 'personal';

    if (body?.tier !== undefined) {
      sub.tier = nextTier;
      // 降级必须摘团队关系（2026-10-12 质检）：只改 tier 不摘 team_id 的话，
      // resolvePluginSubscription 仍走团队分支（team_id 非空）→ 成员照常有权益、
      // AI 门禁照旧放行 team 功能，「降级」只在列表页生效，是假的。
      // ⚠️ 二轮质检 #1：摘 team_id 会把团队行变成个人行，若该用户**已有个人行**
      // （团长双行是 0035 后的典型形态），会撞 0035 部分唯一索引 → PG 23505 →
      // 管理端只看到 500。必须先查个人行，有就明确拒绝。
      if (sub.tier === 'personal' && sub.team_id != null) {
        const personalRow = await this.subRepo.findOne({
          where: { user_id: sub.user_id, plugin_id: sub.plugin_id, team_id: IsNull() },
        });
        if (personalRow) {
          throw new BadRequestException(
            '该用户已持有个人订阅，不能将团队订阅降级为个人版（会撞唯一约束）；请先取消个人订阅，或直接删除该团队订阅',
          );
        }
        sub.team_id = null;
        sub.seats = null;
        sub.max_devices_per_member = null;
      }
    }

    // 席位制（0035）：后台编辑席位数 / 每成员设备数。
    // 加席即时生效（邀请时实时查 MAX(seats)，无缓存）；缩席只拦新邀请、
    // 不剔除已入成员——避免改数字就把付费用户的权益掐了（拍板 2026-10-12）。
    // ⚠️ 四轮质检：只在**团队行**上写席位。旧实现不看 tier，请求体同时带
    //    `tier=personal` + `seats` 时，会在上面刚把 seats 置 null 之后又写回去，
    //    产出 `tier=personal, team_id=NULL, seats=N` 的畸形行（违反
    //    「个人行 seats 恒为 null」不变量，列表页会展示席位数）。
    if (nextTier === 'team') {
      if (body?.seats !== undefined && body?.seats !== null && body?.seats !== '') {
        sub.seats = this.normalizeSeats(body.seats, plugin.team_seats ?? 3);
      }
      if (
        body?.max_devices_per_member !== undefined &&
        body?.max_devices_per_member !== null &&
        body?.max_devices_per_member !== ''
      ) {
        sub.max_devices_per_member = this.normalizeSeats(body.max_devices_per_member, 1);
      }
    }
    // 个人行直接编辑成团队行：补建团（与新增入口、支付回调行为一致），
    // 否则权益解析按 team_members 实时查，无 team_id 的团队行等于团长独享。
    // ⚠️ 只在弹窗显式把 tier 提交为 team 时触发（二轮质检 #7）：旧实现只要
    // 行上 tier 已是 team 就补建团——管理员只想改个到期日也会静默建团。
    if (nextTier === 'team' && sub.team_id == null) {
      // ⚠️ 四轮质检：升级守卫对称化。降级分支有「已有个人行 → 400」的保护，
      //    升级分支原先**没有** —— 若该用户已有同插件的团队行，直接 save 会
      //    生成第二行同 (user, plugin) 的团队订阅：0037 生效时撞
      //    `uq_plugin_subs_user_plugin_team` → 23505 → 500（PgErrorFilter 只映射
      //    22P02，23505 仍是默认 500）；0037 未生效时静默产生重复团队行，
      //    后续续期只会命中其中一行，另一行变成陈旧孤儿。
      const teamRow = await this.subRepo.findOne({
        where: { user_id: sub.user_id, plugin_id: sub.plugin_id, team_id: Not(IsNull()) },
      });
      if (teamRow && teamRow.id !== sub.id) {
        throw new BadRequestException(
          '该用户已持有该插件的团队订阅，不能把这条订阅也升级为团队版；请直接编辑已有团队订阅',
        );
      }
      const team = await ensureOwnerTeam(this.subRepo.manager, sub.user_id, body?.team_name);
      sub.team_id = team.id;
      if (sub.seats == null) {
        sub.seats = Math.max(1, Math.round(Number(body?.seats) || plugin.team_seats || 3));
      }
      if (sub.max_devices_per_member == null) sub.max_devices_per_member = 1;
    }

    await this.subRepo.save(sub);
    return sub;
  }

  /** 价格归一化：非负整数（分），非法值归 0 */
  private normalizePrice(v: any): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  }

  /**
   * 席位/设备数归一化（2026-10-12 二轮质检 #8/#9）：
   * NaN/Infinity/非法值回落 fallback（防 PG 22P02 500），上下限 [1, 999]
   * （防误配 999999 席）。与 orders 支付路径的 Math.max(1, …) 口径一致：
   * team_seats=0 时两条路径都得 1 席，不会一个 1 一个 3。
   */
  private normalizeSeats(v: any, fallback: number): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return Math.min(999, Math.max(1, fallback));
    return Math.min(999, Math.max(1, n));
  }

  /**
   * 划线原价归一化。空串 / null / 非法 / 负数 → null（表示不展示划线价）。
   * 与实付价的价格关系（必须更高）不在这里校验：后台允许先填原价再改促销价。
   */
  private normalizeListPrice(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  /** 促销截止时间归一化。空串 / 非法日期 → null（静态促销，不自动回价） */
  private normalizePromoEnds(v: any): Date | null {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  /** 功能点归一化：字符串数组，去空、去重（保序）、限 20 条 / 每条 200 字 */
  private normalizeFeatures(v: any): string[] | null {
    if (v === null || v === undefined || v === '') return null;
    const arr = Array.isArray(v) ? v : String(v).split(/\r?\n/);
    const out: string[] = [];
    for (const raw of arr) {
      const s = String(raw ?? '').trim();
      if (!s) continue;
      const clipped = s.slice(0, 200);
      if (!out.includes(clipped)) out.push(clipped);
      if (out.length >= 20) break;
    }
    return out.length ? out : null;
  }

  /**
   * 设备上限归一化：1-50 的整数，非法/缺失回落 2（主用 + 备用）。
   * 上限设为 0 会让任何设备都无法授权，属于必然误配，故下限强制为 1。
   */
  private normalizeActivations(v: any): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return 2;
    return Math.min(n, 50);
  }

  /**
   * 订阅有效期归一化：1-3650 的整数（天），非法/缺失回落 30（包月）。
   * 上限与 MAX_SUB_DAYS（手动续期单次上限）对齐，防止手滑把 30 打成 30000 变成永久授权。
   */
  private normalizeDuration(v: any): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return 30;
    return Math.min(n, PluginsService.MAX_SUB_DAYS);
  }

  /**
   * 商品类型归一化（0041）：非法/缺失一律回落 'standard'（独立商品）。
   * 未知值不抛错是有意的——若将来加新类型，老前端提交旧表单不该 500。
   */
  private normalizeKind(v: any): 'standard' | 'tier' | 'trial' {
    const s = String(v ?? '').trim();
    return s === 'tier' || s === 'trial' ? s : 'standard';
  }

  /**
   * 每用户限购次数归一化（0041）：NULL = 不限；非法/小于 1 → NULL。
   * 上限 999 只为防手滑填 99999（真实场景值是 1~3）。
   */
  private normalizePurchaseLimit(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(n, 999);
  }

  /** 续费开关归一化：接受 boolean / 'true' / 'false' / 1 / 0；缺失用 fallback */
  private normalizeRenewAllowed(v: any, fallback: boolean): boolean {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = String(v).trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    return fallback;
  }

  /**
   * 解析「所属主插件」（0041）。
   *
   * 规则：
   *   · 显式传了 id → 校验存在性后采用
   *   · 没传 + kind='standard' → null（独立商品，权益在自己身上）
   *   · 没传 + kind 是 tier/trial → 按 slug 前缀猜主行（`alibaba-toolkit-*`）；
   *     猜不到直接抛错。**不允许静默留空** —— 留空就是「用户付费后权益没人读」
   *     那类事故（2026-10-28 试用商品落错行，以及 2026-10-12 年付档位同类问题）。
   */
  private async resolveParentInput(
    v: any,
    kind: 'standard' | 'tier' | 'trial',
    slug: string,
  ): Promise<string | null> {
    const explicit = v === null || v === undefined ? '' : String(v).trim();
    if (explicit) {
      const parent = await this.pluginRepo.findOne({ where: { id: explicit } });
      if (!parent) throw new BadRequestException('「所属主插件」不存在，请重新选择');
      if (String(slug || '').trim() === parent.slug) {
        throw new BadRequestException('「所属主插件」不能是商品自身');
      }
      return parent.id;
    }
    if (kind === 'standard') return null;

    const main = await this.pluginRepo.findOne({ where: { slug: MAIN_PLUGIN_SLUG } });
    if (main && String(slug || '').startsWith(`${MAIN_PLUGIN_SLUG}-`)) return main.id;
    throw new BadRequestException(
      '价格档位 / 试用商品必须指定「所属主插件」：扩展端只按主插件行读权益，留空会导致用户付费后无法使用',
    );
  }

  /** 由名称生成 ascii slug；名称含中文时退化为随机短串 */
  private genSlug(name: string): string {
    const ascii = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (ascii) return ascii;
    return `p-${Math.random().toString(36).slice(2, 8)}`;
  }
}
