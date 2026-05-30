import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToOne } from 'typeorm';
import { User } from '../auth/user.entity';
import { SkillStatus } from '@platform/shared';

@Entity('skills')
export class Skill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ nullable: true })
  summary: string;

  @Column({ nullable: true })
  short_summary: string;

  @Column({ type: 'text', nullable: true })
  content_md: string;

  @Column({ type: 'jsonb', nullable: true })
  io_schema: any;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ nullable: true })
  cover_url: string;

  @Column({ type: 'enum', enum: SkillStatus, default: SkillStatus.PUBLISHED })
  status: SkillStatus;

  @OneToOne('SkillStats', 'skill')
  stats: any;

  @Column({ nullable: true })
  owner_user_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'owner_user_id' })
  owner_user: User;

  @Column({ nullable: true })
  owner_team_id: string;

  @Column({ nullable: true })
  latest_version_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
