import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Skill } from './skill.entity';

@Entity('skill_versions')
export class SkillVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  skill_id: string;

  @ManyToOne(() => Skill)
  @JoinColumn({ name: 'skill_id' })
  skill: Skill;

  @Column()
  version: string;

  @Column({ type: 'jsonb' })
  manifest_json: any;

  @Column()
  package_url: string;

  @Column({ nullable: true })
  checksum: string;

  @Column({ nullable: true })
  size: number;

  @Column({ nullable: true })
  notes: string;

  @CreateDateColumn()
  created_at: Date;
}
