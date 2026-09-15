import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin, PluginSubscription } from './plugin.entity';
import { OrdersService } from '../payments/orders.service';
import { OssService } from '../storage/oss.service';

@Injectable()
export class PluginsService {
  constructor(
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
    @InjectRepository(PluginSubscription)
    private readonly subRepo: Repository<PluginSubscription>,
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

  /**
   * 卡密校验（供插件客户端激活用，公开、无 JWT）。
   * 仅按卡密查订阅，返回最小可见信息；不区分「不存在/已过期/已取消」，统一 valid=false 防探测。
   * 卡密 ~80bit 随机熵，爆破不可行；插件客户端仅在启动/到期临近时低频调用，无需额外限流。
   */
  async verifyKey(key: string): Promise<{
    valid: boolean;
    plugin_id?: string;
    plugin_slug?: string;
    plugin_name?: string;
    expires_at?: string;
    status?: string;
  }> {
    const sub = await this.subRepo.findOne({ where: { license_key: key } });
    if (!sub) return { valid: false };
    const active = sub.status === 'active' && sub.expires_at.getTime() > Date.now();
    if (!active) return { valid: false, status: sub.status };
    const plugin = await this.pluginRepo.findOne({ where: { id: sub.plugin_id } });
    return {
      valid: true,
      plugin_id: sub.plugin_id,
      plugin_slug: plugin?.slug,
      plugin_name: plugin?.name,
      expires_at: sub.expires_at.toISOString(),
      status: sub.status,
    };
  }
}
