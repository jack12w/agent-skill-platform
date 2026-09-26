import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * 设备授权记录：一行 = 一台已授权设备。
 *
 * 为什么是表而不是订阅上的 text[]：
 *  - 数组无法「只吊销一台」（换电脑/转手要精确吊销，不能连坐其他设备）；
 *  - 数组无法记 last_seen_at（客服排障「用户说登不上」时第一件要看的东西）；
 *  - 两台设备同时激活会 read-modify-write 互相覆盖，静默丢一台。
 */
@Entity('plugin_devices')
@Index('uq_plugin_devices_uid_pid_did', ['user_id', 'plugin_id', 'device_id'], {
  unique: true,
})
export class PluginDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Index()
  @Column({ type: 'uuid' })
  plugin_id: string;

  /** 插件客户端安装时生成并持久化的稳定设备指纹（见接入文档 deviceId 规范） */
  @Column({ type: 'text' })
  device_id: string;

  /**
   * sha256(设备令牌)。**明文永不落库**，仅在轮询响应中出现一次。
   * NULL = 用户已批准，但插件还没来取令牌（可能中途关掉了浏览器）。
   */
  @Index('uq_plugin_devices_token', {
    unique: true,
    where: '"token_hash" IS NOT NULL',
  })
  @Column({ type: 'text', nullable: true })
  token_hash: string;

  /** 客户端上报，用于账户页展示「Chrome · Windows」这类可识别信息 */
  @Column({ type: 'text', nullable: true })
  device_name: string;

  @Column({ type: 'text', nullable: true })
  platform: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at: Date;

  /**
   * 令牌**签发**时刻（绝对有效期的起点，见 TOKEN_MAX_AGE_MS = 90 天）。
   * 与 created_at 的区别：created_at 是这一行被创建的时间，而行会被复用
   * （吊销后同一台设备重新授权 → revoked_at 置 NULL、换新令牌），此时 created_at 不变。
   * NULL = 尚未签发（已批准但插件没来取令牌），或迁移前的老数据。
   *
   * 迁移：migrations/0024_plugin_device_token_age.sql（必须先在库上跑，否则查询会 500）。
   */
  @Column({ type: 'timestamptz', nullable: true })
  token_issued_at: Date;

  /** 非 NULL = 已吊销，该设备的令牌立即失效 */
  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/**
 * 授权请求（设备码流程的短时状态）。
 *
 * 涉及凭证交接，故走数据库而非内存/Redis：
 * 令牌下发靠 `UPDATE ... WHERE consumed_at IS NULL` 的原子抢占保证「只发一次」，
 * 与资金侧的终态门控同一套路（affected=0 即说明已被消费，直接返回，绝不下发第二次）。
 */
@Entity('plugin_auth_requests')
export class PluginAuthRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 用户可见的 8 位数字码 */
  @Index('uq_plugin_auth_req_code', { unique: true })
  @Column({ type: 'text' })
  code: string;

  /** sha256(轮询凭据)：拿令牌必须同时提供它，光猜中 code 无用 */
  @Column({ type: 'text' })
  poll_secret_hash: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  plugin_id: string;

  /**
   * 发起授权的那台设备。**审批时以此为准**，不信网页传来的 deviceId ——
   * 保证用户点「确认」授权的就是他刚刚发起请求的那台机器。
   */
  @Column({ type: 'text' })
  device_id: string;

  @Column({ type: 'text', nullable: true })
  device_name: string;

  @Column({ type: 'text', nullable: true })
  platform: string;

  /** pending=待确认 approved=已确认 denied=已拒绝 */
  @Column({ type: 'text', default: 'pending' })
  status: string;

  @Column({ type: 'uuid', nullable: true })
  user_id: string;

  /**
   * 被拒/失败原因，透传给插件端做可操作的提示：
   * NO_SUBSCRIPTION | EXPIRED_SUBSCRIPTION | ACTIVATION_LIMIT | USER_DENIED
   */
  @Column({ type: 'text', nullable: true })
  deny_reason: string;

  /** 非 NULL = 令牌已下发过，不可再下发 */
  @Column({ type: 'timestamptz', nullable: true })
  consumed_at: Date;

  /** 轮询次数；超过上限即作废，防 8 位码被枚举 */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Index()
  @Column({ type: 'timestamptz' })
  expires_at: Date;
}
