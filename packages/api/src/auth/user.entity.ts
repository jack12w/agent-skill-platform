import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // 微信登录用户初始无邮箱，允许为空；唯一约束下 Postgres 允许多个 NULL。
  @Column({ unique: true, nullable: true })
  email: string;

  // 邮箱是否已验证。true=真实可用邮箱（历史邮箱用户默认 true）；
  // 微信未绑邮箱用户为 false，订阅邮件门禁据此跳过。
  @Column({ default: true })
  email_verified: boolean;

  @Column({ select: false })
  password_hash: string;

  @Column()
  name: string;

  @Column({ default: 'user' })
  role: string;

  @Column({ nullable: true })
  avatar_url: string;

  @Column({ nullable: true })
  bio: string;

  @Column('text', { array: true, nullable: true })
  tags: string[];

  @Column({ nullable: true, select: false })
  wechat_openid: string;

  @Column({ nullable: true, select: false })
  wechat_unionid: string;

  @CreateDateColumn()
  created_at: Date;

  // 最近一次活跃时间：PresenceMiddleware 在任意带有效 token 的请求时节流更新（5 分钟粒度）。
  // 管理端用户列表"最近访问"列 + 7/30/90/180/365 天活跃数统计基于此列。
  // NULL = 迁移前注册且之后从未活跃（或从未登录使用过）。
  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
