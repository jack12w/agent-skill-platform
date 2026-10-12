import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../auth/user.entity';

@Entity('teams')
export class Team {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column('text', { array: true, nullable: true })
  tags: string[];

  @Column()
  owner_user_id: string;

  /**
   * 团队用途（0036）：'skill' = skills 协作团队（默认，存量全归此类）；
   * 'plugin' = 插件团队订阅的专属团（ensureOwnerTeam 只认/只建此类）。
   * 两类彻底隔离：买插件团队版**不会**复用 skills 团，skills 团成员也吃不到插件权益。
   */
  @Column({ default: 'skill' })
  kind: string;

  @Column({ default: true })
  is_public: boolean;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'owner_user_id' })
  owner: User;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
