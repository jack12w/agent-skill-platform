import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from './team.entity';
import { TeamMember } from './team-member.entity';
import { Skill } from '../skills/skill.entity';
import { MemberRole } from '@platform/shared';

@Injectable()
export class TeamsService {
  constructor(
    @InjectRepository(Team)
    private teamRepository: Repository<Team>,
    @InjectRepository(TeamMember)
    private memberRepository: Repository<TeamMember>,
    @InjectRepository(Skill)
    private skillRepository: Repository<Skill>,
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
      where: { owner_team_id: teamId },
      relations: ['stats'],
      order: { created_at: 'DESC' },
    });

    const myMembership = userId
      ? members.find((m) => m.user_id === userId)
      : null;

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

    return {
      ...team,
      members: safeMembers,
      skills,
      is_owner: !!userId && team.owner_user_id === userId,
      my_role: myMembership?.role ?? null,
    };
  }

  async updateTeam(teamId: string, data: { name?: string; description?: string }, userId: string) {
    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.owner_user_id !== userId) {
      throw new ForbiddenException('Only the team owner can edit it');
    }

    const patch: Partial<Team> = {};
    if (typeof data.name === 'string' && data.name.trim()) patch.name = data.name.trim();
    if (typeof data.description === 'string') patch.description = data.description.trim() || null;

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
