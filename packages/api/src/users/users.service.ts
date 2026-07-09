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

  async findOne(username: string) {
    // Find user by name (username is the name field)
    const user = await this.userRepository.findOne({
      where: { name: username },
      select: ['id', 'name', 'avatar_url', 'bio', 'tags', 'created_at'],
    });

    if (!user) throw new NotFoundException('User not found');

    // Count user's published skills
    const skillCount = await this.skillRepository.count({
      where: { owner_user_id: user.id, status: SkillStatus.PUBLISHED },
    });

    // Aggregate stats
    const statsAgg = await this.skillRepository
      .createQueryBuilder('skill')
      .leftJoin('skill.stats', 'stats')
      .select('COALESCE(SUM(stats.likes_total), 0)', 'total_likes')
      .addSelect('COALESCE(SUM(stats.downloads_total), 0)', 'total_downloads')
      .where('skill.owner_user_id = :userId', { userId: user.id })
      .andWhere('skill.status = :status', { status: SkillStatus.PUBLISHED })
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

    const [skills, total] = await this.skillRepository.findAndCount({
      where: { owner_user_id: user.id, status: SkillStatus.PUBLISHED },
      relations: ['stats', 'owner_user', 'latest_version', 'published_version'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    });

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
