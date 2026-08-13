import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Team } from './team.entity';
import { User } from '../auth/user.entity';
import { MemberRole } from '@platform/shared';

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected';

/**
 * 团队加入申请（公开申请 + owner 审批，与「按邮箱邀请」并列的第二种加成员方式）。
 * 角色/状态用 varchar 存储（不依赖 member_role PG 枚举类型，新建表零风险）；
 * 取值约束在应用层校验（role ∈ maintainer/viewer；status ∈ pending/approved/rejected）。
 */
@Entity('team_join_requests')
export class TeamJoinRequest {
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

  @Column({ type: 'varchar', length: 20, default: MemberRole.VIEWER })
  role: MemberRole;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status: JoinRequestStatus;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
