import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 接收站内通知的用户 id */
  @Column()
  @Index()
  user_id: string;

  /** 通知类型，目前固定为 'subscription' */
  @Column({ default: 'subscription' })
  type: string;

  /** 子类型：new_skill / new_version（多个时用逗号分隔） */
  @Column({ nullable: true })
  subtype: string;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  /** 点击跳转地址（被订阅主体的主页，可在此取消订阅） */
  @Column({ nullable: true })
  link: string;

  /** 扩展载荷：订阅通知存储 skills 列表等结构化数据 */
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any>;

  @Column({ default: false })
  read: boolean;

  @CreateDateColumn()
  created_at: Date;
}
