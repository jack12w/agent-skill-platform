import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { User } from '../auth/user.entity';
import { PluginDevice } from './plugin-auth.entity';
import { isSubscriptionEntitled } from './plugin-auth.util';
import { OrdersService } from '../payments/orders.service';
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
  async mySubscriptions(userId: string): Promise<PluginSubscription[]> {
    return this.subRepo.find({
      where: { user_id: userId },
      order: { started_at: 'DESC' },
    });
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
    const plugin = await this.pluginRepo.findOne({ where: { id: pluginId } });
    if (!plugin || plugin.status !== 'active') {
      throw new NotFoundException('插件不存在或未上架');
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
    const sub = await this.subRepo.findOne({
      where: { user_id: userId, plugin_id: pluginId },
    });
    if (!sub) throw new NotFoundException('未找到订阅记录');
    if (sub.status === 'cancelled') return sub;   // 幂等：重复点不再写库
    sub.status = 'cancelled';
    return this.subRepo.save(sub);
  }

  // 设备授权相关（校验/审批/吊销）全部在 PluginsAuthService，本服务不管凭证。

  // ─────────────────────── 后台上架管理（AdminGuard 保护） ───────────────────────

  /** 后台列表：含下架，按排序 */
  async adminList(): Promise<Plugin[]> {
    return this.pluginRepo.find({ order: { sort_order: 'ASC', created_at: 'ASC' } });
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

  /**
   * 后台：某插件的订阅列表（join users 取邮箱/昵称）。
   *
   * 用 `manager.getRepository(User)` 而不是构造函数注入 —— 注入就要往
   * plugins.module.ts 的 ENTITIES 里加 User，漏一处就是 api 502（本项目踩过）。
   */
  async adminListSubscriptions(pluginId: string, q: any) {
    await this.adminGet(pluginId); // 插件不存在 → 直接 404

    const page = Math.max(1, Math.floor(Number(q?.page) || 1));
    const size = Math.min(100, Math.max(1, Math.floor(Number(q?.size) || 20)));
    const search = String(q?.search ?? '').trim();
    const status = String(q?.status ?? '').trim();

    // 把过滤条件抽成函数：items 与 total 必须走**完全相同**的 where，否则分页数会对不上
    const applyFilters = (qb: any) => {
      qb.where('s.plugin_id = :pluginId', { pluginId });
      if (status) qb.andWhere('s.status = :status', { status });
      if (search) qb.andWhere('(u.email ILIKE :kw OR u.name ILIKE :kw)', { kw: `%${search}%` });
      return qb;
    };

    const items = await applyFilters(
      this.subRepo.createQueryBuilder('s').leftJoin(User, 'u', 'u.id = s.user_id'),
    )
      .select([
        's.id AS id',
        's.user_id AS user_id',
        's.plugin_id AS plugin_id',
        's.plan AS plan',
        's.status AS status',
        's.price_cents AS price_cents',
        's.started_at AS started_at',
        's.expires_at AS expires_at',
        's.order_id AS order_id',
        'u.email AS user_email',
        'u.name AS user_name',
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
    await this.adminGet(pluginId);

    const userId = String(body?.user_id ?? '').trim();
    if (!userId) throw new BadRequestException('请选择要授权的用户');

    const user = await this.subRepo.manager.getRepository(User).findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('用户不存在');

    const { expiresAt, days } = this.parseExpiryInput(body);
    // 状态默认 active（新增/编辑弹窗的默认值也是它）；显式传入才覆盖
    const status = this.parseStatusInput(body, 'active');
    const DAY = 86400_000;
    const now = Date.now();

    const existing = await this.subRepo.findOne({
      where: { user_id: userId, plugin_id: pluginId },
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
      await this.subRepo.save(existing);
      return existing;
    }

    // ⚠️ 这里**不要**给对象加 `as any`：TypeORM 的 create() 有「数组」重载，
    //    传 any 会让 TS 命中数组签名，返回类型变成 PluginSubscription[]（本轮踩到）。
    //    order_id 刻意不传 → 落库为 NULL，这就是「非付费」的天然标记。
    const sub = this.subRepo.create({
      user_id: userId,
      plugin_id: pluginId,
      plan: 'manual',
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
    const sub = await this.subRepo.findOne({ where: { id: subId } });
    if (!sub) throw new NotFoundException('订阅记录不存在');
    if (sub.plugin_id !== pluginId) {
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
