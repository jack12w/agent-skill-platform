import {
  Entity,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { Skill } from '../skills/skill.entity';

/**
 * BIGINT(分) 列与 TS number 互转。
 * pg 驱动默认把 bigint 读成 string，统一在此转换，避免算术时字符串拼接。
 */
export const bigintTransformer = {
  to: (v: number | null | undefined) => (v == null ? null : Number(v)),
  from: (v: string | null | undefined) => (v == null ? null : Number(v)),
};

/** 平台交易配置（原 admin.service.ts 硬编码 settings 配置化） */
@Entity('platform_settings')
export class PlatformSetting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'jsonb' })
  value: any;

  @Column({ type: 'uuid', nullable: true })
  updated_by: string;

  @CreateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/** 商品定价（挂在技能上） */
@Entity('skill_pricing')
export class SkillPricing {
  @PrimaryColumn({ type: 'uuid' })
  skill_id: string;

  @ManyToOne(() => Skill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'skill_id' })
  skill: Skill;

  @Column({ default: 'free' }) // free|paid|member_only|both
  pricing_mode: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  price_cents: number;

  @Column({ default: false })
  member_included: boolean;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  commercial_price_cents: number;

  @Column({ default: 'CNY' })
  currency: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/** 订单 */
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ unique: true })
  order_no: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column() // skill|membership
  type: string;

  @Column({ default: 'CREATED' })
  status: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  total_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  paid_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  refunded_cents: number;

  @Column({ default: 1000 })
  commission_rate_bp_snapshot: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expire_at: Date;
}

/** 订单项（下单即算好分成金额，不复算） */
@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  order_id: string;

  @Column() // skill|membership
  subject_type: string;

  @Column({ type: 'uuid', nullable: true })
  subject_id: string;

  @Column({ type: 'uuid', nullable: true })
  seller_user_id: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  unit_cents: number;

  @Column({ default: 1 })
  qty: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  commission_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  seller_income_cents: number;

  @Column({ type: 'jsonb', nullable: true })
  snapshot: any;
}

/** 支付流水 */
@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  order_id: string;

  @Column({ default: 'wechat' })
  channel: string;

  @Column() // NATIVE|JSAPI|H5
  trade_type: string;

  @Column({ unique: true })
  out_trade_no: string;

  @Column({ unique: true, nullable: true })
  transaction_id: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  amount_cents: number;

  @Column({ default: 'PENDING' })
  status: string;

  @Column({ type: 'jsonb', nullable: true })
  prepay_data: any;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date;

  @Column({ type: 'jsonb', nullable: true })
  raw_notify: any;
}

/** 退款流水 */
@Entity('refunds')
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  order_id: string;

  @Column({ type: 'uuid', nullable: true })
  payment_id: string;

  @Column({ unique: true })
  out_refund_no: string;

  @Column({ nullable: true })
  refund_id: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  amount_cents: number;

  @Column({ nullable: true })
  reason: string;

  @Column({ default: 'PENDING' })
  status: string;

  @Column({ type: 'uuid', nullable: true })
  applied_by: string;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string;

  @Column({ type: 'timestamptz', nullable: true })
  refunded_at: Date;
}

/** 微信回调日志（幂等 + 排障留证） */
@Entity('wechat_notify_logs')
export class WechatNotifyLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  event_type: string;

  @Column({ nullable: true })
  resource_id: string;

  @Column({ type: 'text', nullable: true })
  raw_body: string;

  @Column({ default: false })
  processed: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/** 权益（付费墙判断依据） */
@Entity('entitlements')
export class Entitlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Index()
  @Column({ type: 'uuid' })
  skill_id: string;

  @Column() // purchase|membership|author|gift
  source: string;

  @Column({ default: 'personal' })
  license: string;

  @Column({ type: 'uuid', nullable: true })
  order_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  granted_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date;
}

/** 会员 */
@Entity('memberships')
export class Membership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Column() // monthly|quarterly|yearly
  plan: string;

  @Column({ default: 'active' }) // active|expired|cancelled
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  started_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ default: false })
  auto_renew: boolean;

  @Column({ type: 'uuid', nullable: true })
  order_id: string;
}

/** 创作者余额 */
@Entity('creator_balances')
export class CreatorBalance {
  @PrimaryColumn({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  available_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  frozen_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  total_earned_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  total_withdrawn_cents: number;

  @VersionColumn()
  version: number;
}

/** 余额流水（复式，永不删改） */
@Entity('balance_transactions')
export class BalanceTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Column() // in|out
  direction: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  amount_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  balance_after_cents: number;

  @Column() // sale|membership|refund_deduct|withdraw|adjust
  biz_type: string;

  @Column({ type: 'uuid', nullable: true })
  ref_id: string;

  @Column({ type: 'text', nullable: true })
  remark: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/** 提现申请 */
@Entity('withdrawals')
export class Withdrawal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  amount_cents: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  fee_cents: number;

  @Column({ default: 'PENDING' }) // PENDING|REVIEWING|PAID|FAILED|CANCELLED
  status: string;

  @Column({ default: 'wechat_transfer' })
  channel: string;

  @Column({ nullable: true })
  target_openid: string;

  @Column({ nullable: true })
  real_name: string;

  @Column({ unique: true })
  out_bill_no: string;

  @Column({ nullable: true })
  transfer_bill_no: string;

  @CreateDateColumn({ type: 'timestamptz' })
  applied_at: Date;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date;

  @Column({ type: 'text', nullable: true })
  fail_reason: string;
}

/** 实体类数组（供 TypeOrmModule.forFeature 使用） */
/**
 * 创作者会员定价（每个 user / team 一套月/季/年三档价格，由创作者自行设置）。
 * 替代原"全平台统一会员价"。未设置的创作者不对外提供会员订阅。
 */
@Entity('creator_membership_plans')
@Index(['target_type', 'target_id'], { unique: true })
export class CreatorMembershipPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column() // user | team
  target_type: string;

  @Index()
  @Column({ type: 'uuid' })
  target_id: string;

  @Column({ type: 'int', default: 0 }) // 0 = 该档未开通
  monthly_cents: number;

  @Column({ type: 'int', default: 0 })
  quarterly_cents: number;

  @Column({ type: 'int', default: 0 })
  yearly_cents: number;

  @Column({ default: 'CNY' })
  currency: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/**
 * 创作者会员订阅（用户订阅某个创作者 user/team 的会员）。
 * 一个订阅者对一个目标同时只有一条有效记录（续费则顺延 expires_at）。
 */
@Entity('creator_subscriptions')
@Index(['user_id', 'target_type', 'target_id'], { unique: true })
export class CreatorSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string; // 订阅者

  @Column() // user | team
  target_type: string;

  @Column({ type: 'uuid' })
  target_id: string; // 创作者 user_id 或 team_id

  @Column() // monthly | quarterly | yearly
  plan: string;

  @Column({ type: 'int' })
  price_cents: number;

  @Column({ default: 'CNY' })
  currency: string;

  @Column({ default: 'active' }) // active | expired | cancelled
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  started_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'uuid', nullable: true })
  order_id: string;
}

export const PAYMENT_ENTITIES = [
  PlatformSetting,
  SkillPricing,
  Order,
  OrderItem,
  Payment,
  Refund,
  WechatNotifyLog,
  Entitlement,
  Membership,
  CreatorMembershipPlan,
  CreatorSubscription,
  CreatorBalance,
  BalanceTransaction,
  Withdrawal,
];
