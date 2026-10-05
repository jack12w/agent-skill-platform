import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * AI 数据服务 · 推送日志（0026）。
 * push 全量留痕（含失败与重试终态），管理看板「推送成功/失败」数据源。
 * ⚠️ error 只存契约错误信息/path，禁存 payload 原文与任何凭证（日志卫生红线）。
 */
@Entity('ai_push_log')
export class AiPushLog {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  /** ok | rejected | error */
  @Column({ type: 'varchar', length: 16 })
  status: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  type: string | null;

  @Column({ type: 'integer', nullable: true })
  bytes: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
