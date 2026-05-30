import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { LeaderboardType, LeaderboardPeriod } from '@platform/shared';

@Entity('leaderboard_snapshots')
export class LeaderboardSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: LeaderboardType })
  type: LeaderboardType;

  @Column({ type: 'enum', enum: LeaderboardPeriod })
  period: LeaderboardPeriod;

  @Column({ type: 'date' })
  snapshot_date: string;

  @Column({ type: 'jsonb' })
  data_json: any;

  @CreateDateColumn()
  created_at: Date;
}
