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
}
