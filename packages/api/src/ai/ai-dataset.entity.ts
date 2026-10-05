import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * AI 数据服务 · 数据集主表（migrations/0026_ai_data_service.sql）。
 *
 * 唯一键 (user_id, type, range_days, collected_at) 刻意不含 source：
 * 同一份采集（手动/自动两条链路重推）视为同一份数据，去重而非双存。
 * 服务端写入用 INSERT ... ON CONFLICT DO NOTHING 原子去重，禁止 SELECT-then-INSERT。
 *
 * user_id 是 uuid（users.id 同型）；source/vendor_slug/ext_ver DEFAULT ''，老版本插件不传也照收。
 */
@Entity('ai_dataset')
@Index('idx_ai_dataset_q', ['user_id', 'type', 'collected_at'])
export class AiDataset {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'uuid' })
  user_id: string;

  /** visitors | growth_risk | rfq_leads */
  @Column({ type: 'varchar', length: 32 })
  type: string;

  /** manual | auto */
  @Column({ type: 'varchar', length: 32, default: '' })
  source: string;

  /** 信封 vendorSlug 落库（多插件线预留） */
  @Column({ type: 'varchar', length: 64, default: '' })
  vendor_slug: string;

  /** 插件版本（诊断坏数据来自哪个版本） */
  @Column({ type: 'varchar', length: 32, default: '' })
  ext_ver: string;

  @Column({ type: 'integer', default: 7 })
  range_days: number;

  @Column({ type: 'timestamptz' })
  collected_at: Date;

  @Column({ type: 'integer', default: 1 })
  schema_ver: number;

  /** records 条数（冗余列，查询侧免解 JSONB） */
  @Column({ type: 'integer', default: 0 })
  count: number;

  @Column({ type: 'jsonb' })
  payload: unknown;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
