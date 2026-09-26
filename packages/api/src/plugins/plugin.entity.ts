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

  /** 包月实付价（分）。促销期取这个；促销结束后回落到 list_price_monthly_cents */
  @Column({ type: 'int', default: 0 })
  price_monthly_cents: number;

  /**
   * 划线原价（分）。NULL 或 <= 实付价 = 不做「划线价」展示。
   * 促销是否仍在进行由 promo_ends_at 决定。
   */
  @Column({ type: 'int', nullable: true })
  list_price_monthly_cents: number | null;

  /**
   * 促销截止时间。NULL = 促销静态生效（**不自动回价**，由后台手工改价）；
   * 非 NULL 且已过 → 下单回落到 list_price_monthly_cents，前端不再显示划线价。
   */
  @Column({ type: 'timestamptz', nullable: true })
  promo_ends_at: Date | null;

  /** 商品含的功能点（纯展示，客户端也可读） */
  @Column({ type: 'text', array: true, nullable: true })
  features: string[] | null;

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

  /**
   * 允许同时授权使用的设备数（默认 2：主用 + 备用/重装）。
   * 放在商品而非订阅上：这是**商品属性**（团队版可以给 10 台），后台逐款可调。
   */
  @Column({ type: 'int', default: 2 })
  max_activations: number;

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
}
