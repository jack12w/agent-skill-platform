import { EntityManager } from 'typeorm';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { User } from '../auth/user.entity';
import { MemberRole } from '@platform/shared';

/**
 * 团队订阅发放的「自动建团」（0035，2026-10-12 拍板）：
 * 购买者已是某团 owner → 复用该团（一个 owner 一个默认团，避免团蔓延）；
 * 否则建新团「{名字}的团队」并把购买者写为 owner 成员行。
 *
 * 支付回调（fulfillPluginSubscription）与后台手动开通（adminAddSubscription）
 * 两条发放路径共用；团队实体由 teams 模块注册元数据，任意 EntityManager 可取仓库。
 */
export async function ensureOwnerTeam(
  em: EntityManager,
  userId: string,
  name?: string,
): Promise<Team> {
  const teamRepo = em.getRepository(Team);
  const memberRepo = em.getRepository(TeamMember);

  const existing = await teamRepo.findOne({ where: { owner_user_id: userId } });
  if (existing) return existing;

  const user = await em
    .getRepository(User)
    .findOne({ where: { id: userId }, select: ['id', 'name'] });
  const team = await teamRepo.save(
    teamRepo.create({
      name: (name || '').trim() || `${user?.name || '我的'}的团队`,
      owner_user_id: userId,
    } as Partial<Team>),
  );
  await memberRepo.save(
    memberRepo.create({
      team_id: team.id,
      user_id: userId,
      role: MemberRole.OWNER,
    }),
  );
  return team;
}
