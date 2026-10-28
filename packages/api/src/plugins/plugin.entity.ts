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

  /**
   * 订阅有效期（天）（0033）——本款插件新开/续费订阅的**默认时长**。
   * 付费开通（fulfillPluginSubscription）与后台手动开通都以它为准；后台逐款可调。
   * 默认 30 = 原「包月 30 天」行为；年付等长周期档位落地前，先靠它按款配置。
   */
  @Column({ type: 'int', default: 30 })
  subscription_duration_days: number;

  /**
   * 团队档含席位数（0035）。NULL = 该款没有团队档概念；
   * 团队档商品（如 alibaba-toolkit-b2b）配置它，发放团队订阅时快照到 seats。
   */
  @Column({ type: 'int', nullable: true })
  team_seats: number | null;

  /**
   * 商品类型（0041，2026-10-28）：
   *   standard = 独立商品（自己的权益实体，如基础版 alibaba-toolkit）
   *   tier     = 同一插件的价格档位（Pro 年付 / Team 专业版），权益落在 parent_plugin_id
   *   trial    = 试用，默认自带「限购 1 次 + 不可续费」
   *
   * 为什么不再靠 slug 前缀判定：运营手工建商品时把 slug 填成 `7testing`，
   * `isMainPluginTierSlug()` 的前缀判据失效 → 试用订阅落错行 → 插件端读不到权益
   * （2026-10-28 生产事故）。显式字段不依赖命名约定。
   */
  @Column({ type: 'text', default: 'standard' })
  kind: 'standard' | 'tier' | 'trial';

  /**
   * 权益归属的主插件 id（0041）：kind 为 tier/trial 时必填。
   * 扩展端 auth_core.js 写死 DEFAULT_SLUG='alibaba-toolkit'，设备注册/权益校验/AI 门禁
   * 全部只认主插件行 —— 档位订单必须把订阅落在这里。
   * NULL = 独立商品（kind='standard'）；为兼容 0041 之前的数据，判定时再回退 slug 前缀。
   */
  @Column({ type: 'uuid', nullable: true })
  parent_plugin_id: string | null;

  /**
   * 每用户可购买次数上限（0041）。NULL = 不限。
   * 1 = 一次性试用（每人只能买一次）；2/3 = 限量促销。
   * 校验点：下单（orders.createOrder）与发货兜底（fulfillPluginSubscription）；
   * 统计口径 = orders.status IN ('PAID','DELIVERED') 且 refunded_cents = 0 的订单数
   * （退款归还名额，运营可手工退款重置）。
   */
  @Column({ type: 'int', nullable: true })
  max_purchases_per_user: number | null;

  /**
   * 是否允许在账号中心「续费」（0041）。
   * trial 商品恒为 false —— 试用期结束后必须回市场页重新选购，
   * 否则 source_plugin_id 会让续费按试用价（¥0.01/3 天）下单，等于无限白用。
   */
  @Column({ type: 'boolean', default: true })
  renew_allowed: boolean;

  /** 出品方（团队），可为空表示平台直营 */
  @Column({ type: 'uuid', nullable: true })
  owner_team_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/**
 * 用户插件订阅（包月）。同一用户同一插件仅一条**个人**记录（续费顺延 expires_at）；
 * 席位制（0035）起团长可同时持有个人行（team_id NULL）+ 团队行，见下方注释。
 * 付费墙判定：status='active' 且 expires_at > now 即为有效。
 *
 * ⚠️ 唯一性**不由本装饰器承担**：0035 迁移已把 DB 唯一约束换成部分唯一索引
 * `uq_plugin_subs_user_plugin_personal WHERE team_id IS NULL`（只约束个人行）。
 * 此处保留 @Unique 仅为兼容旧文档描述，synchronize:false 下无运行时影响；
 * **任何环境都不要开 schema 同步**——那会按本装饰器重建全列唯一约束，
 * 直接挡掉「团长个人+团队双行」这一 0035 核心设计。
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

  /** 订阅类型（0031）：personal=个人版（默认）/ team=团队版。仅档位标注，不参与判权。 */
  @Column({ type: 'text', default: 'personal' })
  tier: string;

  // ── 团队席位制（0035）──
  /**
   * 团队 id：NULL = 个人订阅（行为与 0035 之前完全一致）；非 NULL = 团队订阅行，
   * user_id 为团长（购买者），权益覆盖该团队全部在册成员（team_members 实时校验）。
   * ⚠️ 唯一性：个人行 UNIQUE(user_id, plugin_id)（部分唯一索引，迁移 0035）；
   *    团队行允许与团长的个人行共存。
   */
  @Column({ type: 'uuid', nullable: true })
  team_id: string;

  /** 席位数（团队行才有；含团长）。发放时从商品 team_seats 快照。 */
  @Column({ type: 'int', nullable: true })
  seats: number;

  /** 每成员设备上限（团队行才有；下单快照，默认 1）。个人行不读此列，仍用商品 max_activations。 */
  @Column({ type: 'int', nullable: true })
  max_devices_per_member: number;

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
   * 购买档位商品 id（0040）：本行权益**最近一次**发放所依据的商品行 id。
   *
   * 权益实体恒在主插件行（`plugin_id` = alibaba-toolkit），本列只解决「记录用户当初
   * 买的是哪一档」——档位商品（`-b2b` 企业版 / `-year` Pro 年付 / 后台新建的任意
   * `alibaba-toolkit-*` 档位）本身不承载权益。
   *   NULL   = 未知（0040 之前且无法由订单还原）或「直接在主插件行购买」
   *   非 NULL = 购买该档位商品的行 id
   * 用途：① 后台订阅列表按档位**精确**筛选（不再靠 tier 猜）；
   *      ② 账号中心续费按同一档位商品重新下单（旧实现按 tier 猜 → 年付用户被按
   *         ¥49/月 续费，少给 335 天）。
   * 写入点：orders.fulfillPluginSubscription（支付发货）、
   *        plugins.adminAddSubscription（后台手动开通）。
   * 后台「编辑订阅」不改写本列（购买事实，非可编辑字段）。
   */
  @Column({ type: 'uuid', nullable: true })
  source_plugin_id: string;
}
