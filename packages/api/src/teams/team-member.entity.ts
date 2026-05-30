import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Team } from './team.entity';
import { User } from '../auth/user.entity';
import { MemberRole } from '@platform/shared';

@Entity('team_members')
export class TeamMember {
  @PrimaryColumn('uuid')
  team_id: string;

  @ManyToOne(() => Team)
  @JoinColumn({ name: 'team_id' })
  team: Team;

  @PrimaryColumn('uuid')
  user_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: MemberRole, default: MemberRole.VIEWER })
  role: MemberRole;

  @CreateDateColumn()
  joined_at: Date;
}
