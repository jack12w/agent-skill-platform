import { EntityManager } from 'typeorm';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { User } from '../auth/user.entity';
import { MemberRole } from '@platform/shared';

/**
 * 团队订阅发放的「自动建团」（0035/0036/0037）：
 * 购买者已有 **plugin 专属团**（kind='plugin'）→ 复用（续费/加购席位不换团，
 * 成员名单保持稳定）；否则建新团「{名字}的插件团队」并把购买者写为 owner 成员行。
 *
 * ⚠️ 0036 隔离铁律：**绝不复用 kind='skill' 的 skills 协作团**——那是技能侧的
 * 成员名单，挂插件权益等于把订阅送给无关用户（2026-10-12 实测踩坑：插件团队
 * 订阅被挂到用户为 skills 建的「盛世TEAM」上）。
 *
 * ⚠️ 0037 并发兜底：findOne→save 是无锁两步，两笔团队订单回调并发时可各建一团。
 * DB 侧有 `uq_teams_owner_plugin`（teams(owner_user_id) WHERE kind='plugin'）
 * 部分唯一索引挡第二行：输家 catch 23505 → 重查赢家的团 → 幂等补自己的成员行
 * （team_members 主键 (team_id, user_id) 天然防重，PK 冲突说明赢家已写，忽略）。
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
  let team: Team;
  try {
    team = await teamRepo.save(
      teamRepo.create({
        name: (name || '').trim() || `${user?.name || '我的'}的插件团队`,
        owner_user_id: userId,
        kind: 'plugin',
      } as Partial<Team>),
    );
  } catch (e: any) {
    // 并发双建团：唯一索引挡下第二行 → 重查赢家的团（其 save 已自动提交，
    // fulfill 路径不在事务中，这里必然看得到）；看不到就原样抛出，交给
    // 订单补发机制重试（订单保持非 DELIVERED）。
    if (String(e?.code) !== '23505') throw e;
    const again = await teamRepo.findOne({
      where: { owner_user_id: userId, kind: 'plugin' },
    });
    if (!again) throw e;
    try {
      await memberRepo.query(
        `INSERT INTO team_members (team_id, user_id, role, joined_at)
         SELECT $1, $2, 'owner', now()
         WHERE NOT EXISTS (
           SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)`,
        [again.id, userId],
      );
    } catch {
      /* 赢家已写成员行（PK 冲突）→ 忽略，团+成员都已就位 */
    }
    return again;
  }
  await memberRepo.save(
    memberRepo.create({
      team_id: team.id,
      user_id: userId,
      role: MemberRole.OWNER,
    }),
  );
  return team;
}
