import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

export type SubscriptionTargetType = 'user' | 'team';

@Entity('subscriptions')
@Unique(['subscriber_id', 'target_type', 'target_id'])
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 订阅人（用户 id） */
  @Column()
  @Index()
  subscriber_id: string;

  /** 被订阅主体类型：user 或 team */
  @Column({ type: 'varchar', length: 16 })
  target_type: SubscriptionTargetType;

  /** 被订阅主体 id：user id 或 team id */
  @Column()
  @Index()
  target_id: string;

  @CreateDateColumn()
  created_at: Date;
}
