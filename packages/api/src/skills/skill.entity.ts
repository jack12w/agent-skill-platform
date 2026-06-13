import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToOne } from 'typeorm';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { SkillStatus } from '@platform/shared';
import { SkillVersion } from './skill-version.entity';

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

  @ManyToOne(() => Team)
  @JoinColumn({ name: 'owner_team_id' })
  owner_team: Team;

  @Column({ nullable: true })
  latest_version_id: string;

  @OneToOne(() => SkillVersion)
  @JoinColumn({ name: 'latest_version_id' })
  latest_version: SkillVersion;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
