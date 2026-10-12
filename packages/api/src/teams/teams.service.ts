import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { TeamJoinRequest } from './team-join-request.entity';
import { Skill } from '../skills/skill.entity';
import { User } from '../auth/user.entity';
import { SkillsService } from '../skills/skills.service';
import { MemberRole, SkillStatus } from '@platform/shared';

@Injectable()
export class TeamsService {
  constructor(
    @InjectRepository(Team)
    private teamRepository: Repository<Team>,
    @InjectRepository(TeamMember)
    private memberRepository: Repository<TeamMember>,
    @InjectRepository(Skill)
    private skillRepository: Repository<Skill>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(TeamJoinRequest)
    private joinRequestRepository: Repository<TeamJoinRequest>,
    private skillsService: SkillsService,
  ) {}

  async createTeam(name: string, description: string, ownerId: string) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new BadRequestException('Team name is required');

    const team = this.teamRepository.create({
      name: trimmed,
      description: (description || '').trim() || null,
      owner_user_id: ownerId,
    } as Partial<Team>);
    const savedTeam = await this.teamRepository.save(team);

    const member = this.memberRepository.create({
      team_id: savedTeam.id,
      user_id: ownerId,
      role: MemberRole.OWNER,
    });
    await this.memberRepository.save(member);

    return savedTeam;
  }

  // 仅团队 owner 可管理成员（含改角色）；复用此断言避免各方法重复判断
  private async assertOwner(teamId: string, operatorId: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.owner_user_id !== operatorId) {
      throw new ForbiddenException('Only the team owner can manage members');
    }
    return team;
  }

  // 团队 owner 或 maintainer 可管理成员（添加 / 移除 / 审批加入申请）；改角色仍限 owner
  private async assertManager(teamId: string, operatorId: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    const member = await this.memberRepository.findOne({ where: { team_id: teamId, user_id: operatorId } });
    if (!member || (member.role !== MemberRole.OWNER && member.role !== MemberRole.MAINTAINER)) {
      throw new ForbiddenException('Only the team owner or a maintainer can manage members');
    }
    return team;
  }

  // ── 团队订阅席位上限（0035）──
  /**
   * 事务内席位校验（0035/2026-10-12 质检）：超员抛错。
   * 席位拦在「加入成员」环节：超员拦邀请，不拦已入成员的权益（拍板 2026-10-12）。
   */
  private async assertSeatAvailable(m: EntityManager, teamId: string) {
    const cap = await this.seatCapInTx(m, teamId);
    if (cap == null) return;
    const rows: Array<{ cnt: number }> = await m.query(
      `SELECT COUNT(*)::int AS cnt FROM team_members WHERE team_id = $1`,
      [teamId],
    );
    if (Number(rows[0]?.cnt || 0) >= cap) {
      throw new BadRequestException(
        `团队订阅席位已满（${cap} 席，含团长），请先移除成员或升级席位后再添加`,
      );
    }
  }

  /**
   * 事务内锁住 team 行（pessimistic_write，0035/2026-10-12 质检）：
   * 同一团队的所有「加入成员」操作（邮箱邀请 / 加入申请审批）在此串行化，
   * 配合 assertSeatAvailable 做到「查数+插入」原子——旧实现在事务外
   * check-then-insert，同时批两个申请可超卖 1 席（多出的成员免费获得权益）。
   */
  private async lockTeamRow(m: EntityManager, teamId: string) {
    const locked = await m.getRepository(Team).findOne({
      where: { id: teamId },
      lock: { mode: 'pessimistic_write' },
    });
    // 预检通过后、拿锁前团队被并发删 → 必须 404，而不是继续插成员撞 FK 23503 变 500
    if (!locked) throw new NotFoundException('Team not found');
  }

  /**
   * 该团队当前有效团队订阅的席位数上限（取最大 seats；含团长）。
   * 无团队订阅 → null（不限制，团队功能本身免费可用）。
   * ⚠️ 查询走传入的事务管理器 m：必须与 lockTeamRow + 插成员同事务同连接，
   * 行锁才挡得住并发（2026-10-12 质检修正）。
   */
  private async seatCapInTx(m: EntityManager, teamId: string): Promise<number | null> {
    const rows: Array<{ cap: number | null }> = await m.query(
      `SELECT MAX(seats) AS cap
         FROM plugin_subscriptions
        WHERE team_id = $1
          AND status IN ('active', 'cancelled')
          AND expires_at > now()`,
      [teamId],
    );
    const cap = rows[0]?.cap;
    return cap == null ? null : Number(cap);
  }

  // 按邮箱直接添加成员：查到已注册用户后直接加入并指定角色（无需对方确认）
  async addMemberByEmail(teamId: string, email: string, role: MemberRole, operatorId: string) {
    const team = await this.assertManager(teamId, operatorId);
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) throw new BadRequestException('Email is required');
    if (role === MemberRole.OWNER) throw new BadRequestException('Cannot add an owner via invite');
    // 仅 owner 可直接添加为管理员；维护者添加时强制为普通成员
    const effectiveRole = team.owner_user_id === operatorId ? role : MemberRole.VIEWER;

    const user = await this.userRepository.findOne({ where: { email: normalized } });
    if (!user) throw new BadRequestException('该邮箱对应的用户不存在');

    const existing = await this.memberRepository.findOne({ where: { team_id: teamId, user_id: user.id } });
    if (existing) throw new BadRequestException('该用户已是团队成员');

    // 事务 + team 行锁（0035/2026-10-12 质检）：锁行 → 复查重复 → 席位校验 → 插入，
    // 全部在同一事务同连接完成。旧实现在事务外 check-then-insert，同时邀请两人
    // 可超卖 1 席（多出的成员凭 team_members 实时校验免费获得插件权益）。
    return this.teamRepository.manager.transaction(async (m) => {
      await this.lockTeamRow(m, teamId);
      const dup = await m.getRepository(TeamMember).findOne({
        where: { team_id: teamId, user_id: user.id },
      });
      if (dup) throw new BadRequestException('该用户已是团队成员');
      await this.assertSeatAvailable(m, teamId);
      const member = m.getRepository(TeamMember).create({
        team_id: teamId,
        user_id: user.id,
        role: effectiveRole,
      });
      return m.getRepository(TeamMember).save(member);
    });
  }

  async updateMemberRole(teamId: string, userId: string, role: MemberRole, operatorId: string) {
    await this.assertOwner(teamId, operatorId);
    if (role === MemberRole.OWNER) throw new BadRequestException('Cannot assign owner role');
    const member = await this.memberRepository.findOne({ where: { team_id: teamId, user_id: userId } });
    if (!member) throw new NotFoundException('Member not found');
    member.role = role;
    return this.memberRepository.save(member);
  }

  async removeMember(teamId: string, userId: string, operatorId: string) {
    const team = await this.assertManager(teamId, operatorId);
    const member = await this.memberRepository.findOne({ where: { team_id: teamId, user_id: userId } });
    if (!member) throw new NotFoundException('Member not found');
    // 所有者与维护者（管理员）不可被直接移除；维护者须先降级为普通成员
    if (team.owner_user_id === userId) throw new BadRequestException('Cannot remove the team owner');
    if (member.role === MemberRole.MAINTAINER) {
      throw new BadRequestException('Cannot remove a maintainer; demote to member first');
    }
    const result = await this.memberRepository.delete({ team_id: teamId, user_id: userId });
    if (result.affected === 0) throw new NotFoundException('Member not found');
    return { ok: true };
  }

  // ── 公开加入申请（与「按邮箱邀请」并列的第二种加成员方式）──

  /** 当前用户申请加入公开团队（owner 无需申请、已成员忽略、重复 pending 报错） */
  async requestToJoin(teamId: string, userId: string, message?: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    // 插件团（kind='plugin'）一律私有：不接受公开加入申请（2026-10-12 二轮质检 M-1），
    // 与 ensureOwnerTeam 的 is_public=false 双保险——防历史/迁移数据 is_public 为 true。
    if (!team.is_public || team.kind === 'plugin') {
      throw new BadRequestException('私有团队不接受公开申请，请联系团队 owner 邀请');
    }
    if (team.owner_user_id === userId) return { ok: true, already: true };
    if (await this.memberRepository.findOne({ where: { team_id: teamId, user_id: userId } })) {
      return { ok: true, already: true };
    }
    const existing = await this.joinRequestRepository.findOne({ where: { team_id: teamId, user_id: userId } });
    if (existing && existing.status === 'pending') {
      throw new BadRequestException('您已提交加入申请，等待 owner 审批');
    }
    // 历史 approved/rejected 记录允许重新申请（覆盖更新）
    const req = this.joinRequestRepository.create({
      team_id: teamId,
      user_id: userId,
      role: MemberRole.VIEWER,
      status: 'pending',
      message: (message || '').trim() || null,
    });
    await this.joinRequestRepository.save(req);
    return { ok: true, request: req };
  }

  /** owner 查看待审申请列表 */
  async listJoinRequests(teamId: string, operatorId: string) {
    await this.assertManager(teamId, operatorId);
    const list = await this.joinRequestRepository.find({
      where: { team_id: teamId, status: 'pending' },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });
    return list.map((r) => ({
      team_id: r.team_id,
      user_id: r.user_id,
      role: r.role,
      status: r.status,
      message: r.message,
      created_at: r.created_at,
      user: { id: r.user.id, name: r.user.name, email: r.user.email, avatar_url: r.user.avatar_url },
    }));
  }

  /** owner 审批：approve 加入成员；reject 仅标记 */
  async reviewJoinRequest(
    teamId: string,
    userId: string,
    action: 'approve' | 'reject',
    role: MemberRole,
    operatorId: string,
  ) {
    const team = await this.assertManager(teamId, operatorId);
    if (role === MemberRole.OWNER) throw new BadRequestException('Cannot assign owner role');
    // 仅 owner 可赋予管理员角色；维护者审批时强制为普通成员
    const effectiveRole = team.owner_user_id === operatorId ? role : MemberRole.VIEWER;
    const req = await this.joinRequestRepository.findOne({
      where: { team_id: teamId, user_id: userId, status: 'pending' },
    });
    if (!req) throw new NotFoundException('Pending request not found');

    if (action === 'reject') {
      req.status = 'rejected';
      await this.joinRequestRepository.save(req);
      return { ok: true, status: 'rejected' };
    }

    // approve：加入成员（若已存在成员不重复插入）。
    // 事务 + team 行锁（0035/2026-10-12 质检）：与「按邮箱邀请」同款串行化，
    // 两个审批并发不再超卖席位；席位校验与成员插入原子完成。
    // 状态翻转也放进同一事务（二轮质检 #6）：旧实现事务提交后才 save req，
    // 崩溃窗口里「成员已入团但申请仍 pending」，且申请人若此时撤销，save 会
    // 把已删的申请行以 approved 复活（TypeORM 主键全赋值 → SELECT 不到 → INSERT）。
    await this.teamRepository.manager.transaction(async (m) => {
      await this.lockTeamRow(m, teamId);
      const dup = await m.getRepository(TeamMember).findOne({
        where: { team_id: teamId, user_id: userId },
      });
      if (!dup) {
        await this.assertSeatAvailable(m, teamId);
        await m.getRepository(TeamMember).save(
          m.getRepository(TeamMember).create({ team_id: teamId, user_id: userId, role: effectiveRole }),
        );
      }
      req.status = 'approved';
      req.role = effectiveRole;
      await m.getRepository(TeamJoinRequest).save(req);
    });
    return { ok: true, status: 'approved' };
  }

  /** 申请人撤销自己的 pending 申请 */
  async cancelJoinRequest(teamId: string, userId: string) {
    const req = await this.joinRequestRepository.findOne({
      where: { team_id: teamId, user_id: userId, status: 'pending' },
    });
    if (!req) throw new NotFoundException('No pending request');
    await this.joinRequestRepository.remove(req);
    return { ok: true };
  }

  async getMyTeams(userId: string) {
    return this.memberRepository.find({
      where: { user_id: userId },
      relations: ['team'],
    });
  }

  async findOne(teamId: string, userId?: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');

    const members = await this.memberRepository.find({
      where: { team_id: teamId },
      relations: ['user'],
    });

    const skills = await this.skillRepository.find({
      where: { owner_team_id: teamId, status: SkillStatus.PUBLISHED },
      relations: ['stats', 'latest_version', 'published_version', 'owner_user'],
      order: { created_at: 'DESC' },
    });

    const myMembership = userId
      ? members.find((m) => m.user_id === userId)
      : null;

    // 「对外展示」开关：关闭时仅团队成员（含 owner）可见
    if (!team.is_public && !myMembership) {
      throw new ForbiddenException('该团队未对外展示，仅团队成员可见');
    }

    // 成员邮箱（PII）只对本团队成员暴露。
    // 原先的判断条件是「是否登录」而不是「是否本团队成员」—— 任何已登录用户访问任意
    // 公开团队主页，都能一次性拉走全部成员的 email。改为非成员一律脱敏，与外部访客同待遇。
    const safeMembers = myMembership
      ? members
      : members.map((m) => ({
          ...m,
          user: m.user
            ? {
                id: m.user.id,
                name: m.user.name,
                avatar_url: m.user.avatar_url,
                bio: m.user.bio,
              }
            : null,
        }));

    // Build skill items with published_version_id
    const skillItems = skills.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      short_summary: s.short_summary,
      cover_url: s.cover_url,
      tags: s.tags,
      created_at: s.created_at,
      updated_at: s.updated_at,
      published_version_id: s.published_version_id,
      owner_user_id: s.owner_user_id,
      owner_user: s.owner_user
        ? { id: s.owner_user.id, name: s.owner_user.name, avatar_url: s.owner_user.avatar_url }
        : null,
      latest_version: s.latest_version ? { version: s.latest_version.version } : null,
      stats: s.stats,
    }));

    // Attach has_update info if current user is logged in
    if (userId) {
      await this.skillsService.attachUpdateInfo(skillItems, userId);
    }

    // 当前登录用户对该团队的待审加入申请（用于详情页「已申请/撤销」状态）
    const hasPendingRequest = userId
      ? myMembership
        ? false
        : !!(await this.joinRequestRepository.findOne({
            where: { team_id: teamId, user_id: userId, status: 'pending' },
          }))
      : null;

    return {
      ...team,
      members: safeMembers,
      skills: skillItems,
      is_owner: !!userId && team.owner_user_id === userId,
      is_manager: !!userId && (team.owner_user_id === userId || myMembership?.role === MemberRole.MAINTAINER),
      my_role: myMembership?.role ?? null,
      has_pending_request: hasPendingRequest,
    };
  }

  async updateTeam(teamId: string, data: { name?: string; description?: string; tags?: string[]; is_public?: boolean }, userId: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.owner_user_id !== userId) {
      throw new ForbiddenException('Only the team owner can edit it');
    }

    const patch: Partial<Team> = {};
    if (typeof data.name === 'string' && data.name.trim()) patch.name = data.name.trim();
    if (typeof data.description === 'string') patch.description = data.description.trim() || null;
    if (Array.isArray(data.tags)) patch.tags = data.tags;
    if (typeof data.is_public === 'boolean') patch.is_public = data.is_public;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No editable fields provided');
    }

    await this.teamRepository.update({ id: teamId }, patch);
    return this.teamRepository.findOne({ where: { id: teamId } });
  }

  async deleteTeam(teamId: string, userId: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.owner_user_id !== userId) {
      throw new ForbiddenException('Only the team owner can delete it');
    }

    /**
     * 插件订阅引用处理（0035 / 2026-10-12 四轮质检）。
     *
     * 背景：`plugin_subscriptions.team_id` 是 **NO ACTION** 外键，订阅行只要还在就挡删；
     * 而全站**没有删除订阅行的入口**（取消只置 `cancelled`、退款只置 `expired`，
     * 控制器也没有 DELETE 路由）。所以旧实现「先取消订阅再解散」在执行层走不通 ——
     * **任何曾经有过插件订阅的团都永远无法解散**，而报错文案却把人指向这条死路。
     *
     * 正确口径：
     *   ① 仍在有效期内、仍产生权益的行（active/cancelled 且 expires_at > now()）
     *      → 明确拒绝（删团=全团成员立刻失去插件权益）；
     *   ② 已失效的历史行 → 只摘团归属（`team_id = NULL`），**不删行**
     *      （订阅行是财务溯源凭证，删了就对不上订单）；摘团要避开 0035 的个人行
     *      部分唯一索引（同 user+plugin 已有个人行会撞），故加 NOT EXISTS 守卫。
     * 整个「摘团 → 复查 → 删团」放在一个事务里：任一环节失败即整体回滚，
     * 不会出现「行被摘了、团还在」的半成品状态。
     */
    return this.teamRepository.manager.transaction(async (m: EntityManager) => {
      const activeRefs: Array<{ cnt: number }> = await m.query(
        `SELECT COUNT(*)::int AS cnt FROM plugin_subscriptions
          WHERE team_id = $1 AND status IN ('active', 'cancelled') AND expires_at > now()`,
        [teamId],
      );
      if (Number(activeRefs[0]?.cnt || 0) > 0) {
        throw new BadRequestException(
          '该团队仍有生效中的插件订阅，不能解散；请先在「订阅管理」取消订阅，待当前订阅期结束后再解散',
        );
      }

      await m.query(
        `UPDATE plugin_subscriptions s SET team_id = NULL
          WHERE s.team_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM plugin_subscriptions p
               WHERE p.user_id = s.user_id
                 AND p.plugin_id = s.plugin_id
                 AND p.team_id IS NULL
            )`,
        [teamId],
      );
      const left: Array<{ cnt: number }> = await m.query(
        `SELECT COUNT(*)::int AS cnt FROM plugin_subscriptions WHERE team_id = $1`,
        [teamId],
      );
      if (Number(left[0]?.cnt || 0) > 0) {
        throw new BadRequestException(
          '该团队存在已失效但无法自动摘除的历史订阅（该用户名下已有同一插件的个人订阅），请先联系平台处理后再解散',
        );
      }

      // Detach skills：回落到个人归属（原创作者 created_by），避免删团队后变成无主孤儿。
      // 主路径：owner_user_id 回填为原创作者；兜底：created_by 为空的极端情况落到团队 owner。
      await m
        .createQueryBuilder()
        .update(Skill)
        .set({ owner_team_id: null, owner_user_id: () => 'created_by' })
        .where('owner_team_id = :teamId', { teamId })
        .andWhere('created_by IS NOT NULL')
        .execute();

      await m
        .createQueryBuilder()
        .update(Skill)
        .set({ owner_team_id: null, owner_user_id: team.owner_user_id })
        .where('owner_team_id = :teamId', { teamId })
        .andWhere('created_by IS NULL')
        .execute();
      // Remove members
      await m.delete(TeamMember, { team_id: teamId });
      // Finally delete team
      await m.delete(Team, { id: teamId });
      return { ok: true };
    });
  }
}
