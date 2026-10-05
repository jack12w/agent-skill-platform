import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * AI 数据服务 · MCP/API 密钥（0026）。
 * sha256 存储、明文仅生成时返回一次、可吊销（revoked_at，判空用 IsNull()）。
 */
@Entity('ai_api_key')
export class AiApiKey {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  key_hash: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  label: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date | null;
}
