import { Entity, PrimaryColumn, Column, UpdateDateColumn, OneToOne, JoinColumn } from 'typeorm';
import { Skill } from './skill.entity';

@Entity('skill_stats')
export class SkillStats {
  @PrimaryColumn('uuid')
  skill_id: string;

  @OneToOne(() => Skill, skill => skill.stats)
  @JoinColumn({ name: 'skill_id' })
  skill: Skill;

  @Column({ default: 0 })
  likes_total: number;

  @Column({ default: 0 })
  downloads_total: number;

  @Column({ default: 0 })
  likes_7d: number;

  @Column({ default: 0 })
  downloads_7d: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  total_score: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  weekly_score: number;

  @UpdateDateColumn()
  updated_at: Date;
}
