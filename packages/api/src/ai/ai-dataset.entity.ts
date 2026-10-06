import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * AI 数据服务 · 数据集主表（migrations/0026 建表；0028 多类型扩展）。
 *
 * 0028 起唯一键 = (user_id, vendor_slug, type, range_days, collected_at, seq)：
 *  - 分批推送（单批上限 5000 条/5MB）同一次采集拆多行，seq 从 1 起；查询端按 seq 合并成逻辑快照；
 *  - 不含 source：同一批（手动/自动重推）视为同一批数据，去重而非双存；
 *  - vendor_slug = 站点线（alibaba/1688），与订阅判定用的 plugins.slug 解耦，存量已归一 'alibaba'。
 * 服务端写入用 INSERT ... ON CONFLICT DO NOTHING 原子去重，禁止 SELECT-then-INSERT。
 *
 * user_id 是 uuid（users.id 同型）；source/ext_ver DEFAULT ''，老版本插件不传也照收。
 */
@Entity('ai_dataset')
@Index('idx_ai_dataset_q', ['user_id', 'type', 'collected_at'])
export class AiDataset {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'uuid' })
  user_id: string;

  /** ai_type_registry.type：visitors/rfq/gold/search/rank/growth/public_customer（管理后台维护） */
  @Column({ type: 'varchar', length: 32 })
  type: string;

  /** manual | auto */
  @Column({ type: 'varchar', length: 32, default: '' })
  source: string;

  /** 站点线 slug（0028 起：alibaba/1688；老值 'alibaba-toolkit'/'' 已迁移归一） */
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

  /** records 条数（冗余列，查询侧免解 JSONB；分批时 = 该批条数） */
  @Column({ type: 'integer', default: 0 })
  count: number;

  /** 分批推送批次序号，从 1 起（0028；单批上限 5000 条/5MB，超限拆批） */
  @Column({ type: 'integer', default: 1 })
  seq: number;

  /**
   * 记录级去重值（0029；仅去重类型非空，如 search 的关键词）：
   * 非空时唯一索引 uq_ai_dataset_dedupe 生效，重复词 upsert 原地更新而非新增快照；
   * NULL = 普通快照行（0028 唯一键语义）。
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  dedupe_val: string | null;

  @Column({ type: 'jsonb' })
  payload: unknown;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
