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

  @UpdateDateColumn()
  updated_at: Date;
}
