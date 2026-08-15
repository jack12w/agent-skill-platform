import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async addMember(teamId: string, userId: string, role: MemberRole) {
    const member = this.memberRepository.create({ team_id: teamId, user_id: userId, role });
    return this.memberRepository.save(member);
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

    const member = this.memberRepository.create({ team_id: teamId, user_id: user.id, role: effectiveRole });
    return this.memberRepository.save(member);
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
    if (!team.is_public) {
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

    // approve：加入成员（若已存在成员不重复插入）
    if (!(await this.memberRepository.findOne({ where: { team_id: teamId, user_id: userId } }))) {
      await this.memberRepository.save(
        this.memberRepository.create({ team_id: teamId, user_id: userId, role: effectiveRole }),
      );
    }
    req.status = 'approved';
    req.role = effectiveRole;
    await this.joinRequestRepository.save(req);
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

    // Sanitize member data for public access (remove email)
    const safeMembers = userId
      ? members
      : members.map((m) => ({
          ...m,
          user: {
            id: m.user.id,
            name: m.user.name,
            avatar_url: m.user.avatar_url,
            bio: m.user.bio,
          },
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

    // Detach skills (do NOT delete them — they fall back to personal ownership)
    await this.skillRepository.update({ owner_team_id: teamId }, { owner_team_id: null });
    // Remove members
    await this.memberRepository.delete({ team_id: teamId });
    // Finally delete team
    await this.teamRepository.delete({ id: teamId });
    return { ok: true };
  }
}
