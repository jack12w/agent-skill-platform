import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { Skill } from '../skills/skill.entity';
import { SkillStats } from '../skills/skill-stats.entity';
import { SkillsService } from '../skills/skills.service';
import { SkillStatus } from '@platform/shared';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Skill)
    private skillRepository: Repository<Skill>,
    private skillsService: SkillsService,
  ) {}

  async findOne(username: string, currentUserId?: string) {
    // Find user by name (username is the name field)
    const user = await this.userRepository.findOne({
      where: { name: username },
      select: ['id', 'name', 'avatar_url', 'bio', 'tags', 'created_at'],
    });

    if (!user) throw new NotFoundException('User not found');

    const isSelf = !!currentUserId && currentUserId === user.id;

    // 团队可见性条件：技能未挂团队 / 团队已公开 / 访客是该团队成员  → 可见
    const visibleCond = (qb: any) => {
      if (isSelf) return qb; // 本人看自己主页，全部可见
      return qb.andWhere(
        '(skill.owner_team_id IS NULL OR t.is_public = true OR tm.user_id IS NOT NULL)',
      );
    };

    const baseQb = () =>
      this.skillRepository
        .createQueryBuilder('skill')
        .leftJoin('teams', 't', 'skill.owner_team_id = t.id')
        .leftJoin(
          'team_members',
          'tm',
          'tm.team_id = skill.owner_team_id AND tm.user_id = :viewerId',
          { viewerId: currentUserId || '' },
        )
        .where('skill.owner_user_id = :userId', { userId: user.id })
        .andWhere('skill.status = :status', { status: SkillStatus.PUBLISHED });

    // Count user's published skills (对访客按团队可见性过滤)
    const skillCount = await visibleCond(baseQb()).getCount();

    // Aggregate stats (同上过滤，保证与列表/数量一致)
    const statsAgg = await visibleCond(baseQb())
      .leftJoin('skill.stats', 'stats')
      .select('COALESCE(SUM(stats.likes_total), 0)', 'total_likes')
      .addSelect('COALESCE(SUM(stats.downloads_total), 0)', 'total_downloads')
      .getRawOne();

    return {
      ...user,
      skill_count: skillCount,
      total_likes: parseInt(statsAgg?.total_likes || '0', 10),
      total_downloads: parseInt(statsAgg?.total_downloads || '0', 10),
    };
  }

  async findUserSkills(username: string, query: { page?: number; size?: number; currentUserId?: string }) {
    const { page = 1, size = 20, currentUserId } = query;

    const user = await this.userRepository.findOne({
      where: { name: username },
      select: ['id'],
    });

    if (!user) throw new NotFoundException('User not found');

    const isSelf = !!currentUserId && currentUserId === user.id;

    const qb = this.skillRepository
      .createQueryBuilder('skill')
      .leftJoinAndSelect('skill.stats', 'stats')
      .leftJoinAndSelect('skill.owner_user', 'owner_user')
      .leftJoinAndSelect('skill.latest_version', 'latest_version')
      .leftJoinAndSelect('skill.published_version', 'published_version')
      .leftJoin('teams', 't', 'skill.owner_team_id = t.id')
      .leftJoin(
        'team_members',
        'tm',
        'tm.team_id = skill.owner_team_id AND tm.user_id = :viewerId',
        { viewerId: currentUserId || '' },
      )
      .where('skill.owner_user_id = :ownerId', { ownerId: user.id })
      .andWhere('skill.status = :status', { status: SkillStatus.PUBLISHED })
      .orderBy('skill.created_at', 'DESC')
      .skip((page - 1) * size)
      .take(size);

    // 非本人访问时，按团队「对外展示」开关过滤：私有团队技能仅成员可见
    if (!isSelf) {
      qb.andWhere(
        '(skill.owner_team_id IS NULL OR t.is_public = true OR tm.user_id IS NOT NULL)',
      );
    }

    const [skills, total] = await qb.getManyAndCount();

    const items = skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      short_summary: skill.short_summary,
      cover_url: skill.cover_url,
      tags: skill.tags,
      created_at: skill.created_at,
      updated_at: skill.updated_at,
      published_version_id: skill.published_version_id,
      owner_user_id: skill.owner_user_id,
      latest_version: skill.latest_version ? { version: skill.latest_version.version } : null,
      likes_total: skill.stats?.likes_total ?? 0,
      downloads_total: skill.stats?.downloads_total ?? 0,
      total_score: skill.stats?.total_score ?? 5,
      weekly_score: skill.stats?.weekly_score ?? 5,
    }));

    // Attach has_update info if current user is logged in
    if (currentUserId) {
      await this.skillsService.attachUpdateInfo(items, currentUserId);
    }

    return {
      items,
      total,
      page,
      size,
    };
  }
}
