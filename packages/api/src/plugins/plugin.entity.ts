import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

/**
 * 插件商品目录（平台自研增效工具，按包月售卖）。
 * 与 skills 完全解耦：不进技能广场/搜索/排行榜，未来加能力只插一行。
 */
@Entity('plugins')
export class Plugin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'text' })
  name: string;

  /** 一句话卖点 */
  @Column({ type: 'text', nullable: true })
  tagline: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text', nullable: true })
  icon_url: string;

  @Column({ type: 'text', default: '通用' })
  category: string;

  /** 包月价（分） */
  @Column({ type: 'int', default: 0 })
  price_monthly_cents: number;

  @Column({ type: 'text', default: 'CNY' })
  currency: string;

  /** active=上架中, hidden=下架 */
  @Column({ type: 'text', default: 'active' })
  status: string;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  /** OSS 对象 key（如 plugins/{id}/client.zip）；下载时签名，不存完整 URL */
  @Column({ type: 'text', nullable: true })
  download_key: string;

  /** 下载展示文件名（用于签名 URL 的 Content-Disposition） */
  @Column({ type: 'text', nullable: true })
  download_filename: string;

  /** 出品方（团队），可为空表示平台直营 */
  @Column({ type: 'uuid', nullable: true })
  owner_team_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/**
 * 用户插件订阅（包月）。同一用户同一插件仅一条记录（续费顺延 expires_at）。
 * 付费墙判定：status='active' 且 expires_at > now 即为有效。
 */
@Entity('plugin_subscriptions')
@Unique(['user_id', 'plugin_id'])
export class PluginSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Index()
  @Column({ type: 'uuid' })
  plugin_id: string;

  @Column({ type: 'text', default: 'monthly' })
  plan: string;

  @Column({ type: 'int', default: 0 })
  price_cents: number;

  @Column({ type: 'text', default: 'CNY' })
  currency: string;

  /** active=生效中, expired=已过期, cancelled=已取消 */
  @Column({ type: 'text', default: 'active' })
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  started_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'uuid', nullable: true })
  order_id: string;

  /**
   * 卡密（license key）：每一条订阅记录一个稳定密钥，续费只顺延 expires_at、卡密不变。
   * 用户购买后在「我的订阅」复制，填入插件客户端；插件调 /api/plugins/verify 校验有效期。
   * 形如 SD-XXXX-XXXX-XXXX-XXXX（~80bit 熵）。部分唯一索引（忽略 NULL）。
   */
  @Index('uq_plugin_subs_license', { unique: true, where: '"license_key" IS NOT NULL' })
  @Column({ type: 'text', nullable: true })
  license_key: string;
}
