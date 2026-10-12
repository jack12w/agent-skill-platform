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

  // 公众号 AppID 命名空间的 openid：微信内网页授权登录写入；支付收款(JSAPI/商家转账)必须用本列。
  // select:false 沿用 last_seen_at 的降级设计：未跑迁移 0018 时默认查询不引用本列。
  @Column({ nullable: true, select: false })
  wechat_openid_oa: string;

  // 网站应用 AppID 命名空间的 openid：PC 扫码登录(qrconnect)/微信绑定写入。
  @Column({ nullable: true, select: false })
  wechat_openid_site: string;

  // ── 邀请推广（迁移 0034，2026-10-12）──
  // 本人的邀请码：懒生成（首次打开邀请页才生成），唯一；迁移里是普通 UNIQUE 索引（多 NULL 合法）。
  @Column({ type: 'varchar', length: 12, unique: true, nullable: true })
  referral_code: string;

  // 被谁邀请（users.id 自引用）：注册（邮箱直接带码）或登录后补绑（微信路径）时绑定一次，
  // 终身不变；补绑仅限「注册 7 天内」账号，防老用户点链接被误绑（拍板 4）。
  // select:false：默认查询不带出，邀请统计/归因处显式读取，未跑 0034 时老查询不受影响。
  @Column({ type: 'uuid', nullable: true, select: false })
  referred_by: string;

  @CreateDateColumn()
  created_at: Date;

  // 最近一次活跃时间：PresenceMiddleware 在任意带有效 token 的请求时节流更新（5 分钟粒度）。
  // 管理端用户列表"最近访问"列 + 7/30/90/180/365 天活跃数统计基于此列（QueryBuilder 显式 select 读取）。
  // NULL = 迁移前注册且之后从未活跃（或从未登录使用过）。
  // select:false 是关键降级设计：未跑迁移 0013 时，登录/注册/个人中心等默认查询不引用本列，
  // 业务接口不受影响；仅管理端用户列表（显式 select）会报错。
  @Column({ type: 'timestamptz', nullable: true, select: false })
  last_seen_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
