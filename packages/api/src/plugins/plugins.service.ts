import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { PluginDevice } from './plugin-auth.entity';
import { OrdersService } from '../payments/orders.service';
import { OssService } from '../storage/oss.service';

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

  /** 公开列表（上架中，按排序） */
  async list(): Promise<Plugin[]> {
    return this.pluginRepo.find({
      where: { status: 'active' },
      order: { sort_order: 'ASC', created_at: 'ASC' },
    });
  }

  async getBySlug(slug: string): Promise<Plugin | null> {
    return this.pluginRepo.findOne({ where: { slug, status: 'active' } });
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

  /** 取消订阅（仅标记，不退款；包月到期满自动失效） */
  async cancel(userId: string, pluginId: string) {
    const sub = await this.subRepo.findOne({
      where: { user_id: userId, plugin_id: pluginId },
    });
    if (!sub) throw new NotFoundException('未找到订阅记录');
    if (sub.status !== 'active') return sub;
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

  /** 价格归一化：非负整数（分），非法值归 0 */
  private normalizePrice(v: any): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
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
