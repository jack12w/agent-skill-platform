import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('page_views')
export class PageView {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  path: string;

  @Column({ nullable: true })
  ip_hash: string;

  @Column({ nullable: true })
  user_agent: string;

  @Column({ nullable: true })
  referrer: string;

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
