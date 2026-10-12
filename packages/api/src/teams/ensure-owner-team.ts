import { EntityManager } from 'typeorm';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { User } from '../auth/user.entity';
import { MemberRole } from '@platform/shared';

/**
 * 团队订阅发放的「自动建团」（0035/0036）：
 * 购买者已有 **plugin 专属团**（kind='plugin'）→ 复用（续费/加购席位不换团，
 * 成员名单保持稳定）；否则建新团「{名字}的插件团队」并把购买者写为 owner 成员行。
 *
 * ⚠️ 0036 隔离铁律：**绝不复用 kind='skill' 的 skills 协作团**——那是技能侧的
 * 成员名单，挂插件权益等于把订阅送给无关用户（2026-10-12 实测踩坑：插件团队
 * 订阅被挂到用户为 skills 建的「盛世TEAM」上）。
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

  const existing = await teamRepo.findOne({
    where: { owner_user_id: userId, kind: 'plugin' },
  });
  if (existing) return existing;

  const user = await em
    .getRepository(User)
    .findOne({ where: { id: userId }, select: ['id', 'name'] });
  const team = await teamRepo.save(
    teamRepo.create({
      name: (name || '').trim() || `${user?.name || '我的'}的插件团队`,
      owner_user_id: userId,
      kind: 'plugin',
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
