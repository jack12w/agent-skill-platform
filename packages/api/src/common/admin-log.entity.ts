import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('admin_logs')
export class AdminLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  admin_user_id: string;

  @Column()
  action: string;

  @Column({ nullable: true })
  target_type: string;

  @Column({ nullable: true })
  target_id: string;

  @Column({ type: 'text', nullable: true })
  detail: string;

  @CreateDateColumn()
  created_at: Date;
}
