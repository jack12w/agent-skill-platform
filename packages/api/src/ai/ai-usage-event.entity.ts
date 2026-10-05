import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * AI 数据服务 · 查询计量（0026）。
 * 每次密钥调用留痕（成功+失败，v2.1 扩展 status/code），未来多收益方分账的预留数据。
 */
@Entity('ai_usage_event')
@Index('idx_ai_usage_q', ['user_id', 'queried_at'])
export class AiUsageEvent {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'bigint', nullable: true })
  api_key_id: number | null;

  @Column({ type: 'varchar', length: 32 })
  type: string;

  @Column({ type: 'integer', nullable: true })
  range_days: number | null;

  @Column({ type: 'integer', default: 0 })
  rows_returned: number;

  /** ok | rejected | error（失败调用也留痕，看板统计「调用成功/失败」） */
  @Column({ type: 'varchar', length: 16, default: 'ok' })
  status: string;

  /** MEMBER_REQUIRED / NOT_FOUND / RATE_LIMITED / UNAUTHORIZED */
  @Column({ type: 'varchar', length: 32, default: '' })
  code: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  queried_at: Date;
}
