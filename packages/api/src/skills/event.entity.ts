import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { EventType } from '@platform/shared';

@Entity('events')
export class Event {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ nullable: true })
  user_id: string;

  @Column({ nullable: true })
  team_id: string;

  @Column()
  skill_id: string;

  @Column({ type: 'enum', enum: EventType, enumName: 'event_type' })
  type: EventType;

  @Column({ type: 'jsonb', nullable: true })
  payload_json: any;

  @Column({ nullable: true })
  ip_hash: string;

  @CreateDateColumn()
  created_at: Date;
}
