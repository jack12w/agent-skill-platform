import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { Skill } from '../skills/skill.entity';
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

    return {
      ...team,
      members: safeMembers,
      skills: skillItems,
      is_owner: !!userId && team.owner_user_id === userId,
      my_role: myMembership?.role ?? null,
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
