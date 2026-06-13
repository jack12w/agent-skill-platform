import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, ILike } from 'typeorm';
import { Skill } from '../skills/skill.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { Comment } from '../skills/comment.entity';
import { Event } from '../skills/event.entity';
import { AdminLog } from './admin-log.entity';
import { SkillStatus } from '@platform/shared';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Skill) private skillRepo: Repository<Skill>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Team) private teamRepo: Repository<Team>,
    @InjectRepository(Comment) private commentRepo: Repository<Comment>,
    @InjectRepository(Event) private eventRepo: Repository<Event>,
    @InjectRepository(AdminLog) private logRepo: Repository<AdminLog>,
  ) {}

  async getStats() {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [
      skillsTotal, usersTotal, teamsTotal, commentsTotal, publishedSkills,
      users7d, skills7d,
      dailyEvents, topSkills,
    ] = await Promise.all([
      this.skillRepo.count(),
      this.userRepo.count(),
      this.teamRepo.count(),
      this.commentRepo.count(),
      this.skillRepo.count({ where: { status: SkillStatus.PUBLISHED } }),
      this.userRepo.createQueryBuilder('u').where('u.created_at >= :d', { d: sevenDaysAgo }).getCount(),
      this.skillRepo.createQueryBuilder('s').where('s.created_at >= :d', { d: sevenDaysAgo }).getCount(),
      // 7日每日 like + download 统计
      this.eventRepo.createQueryBuilder('e')
        .select("DATE(e.created_at) as date")
        .addSelect("COUNT(CASE WHEN e.type = 'like' THEN 1 END)::int", 'likes')
        .addSelect("COUNT(CASE WHEN e.type = 'download' THEN 1 END)::int", 'downloads')
        .where('e.created_at >= :d', { d: sevenDaysAgo })
        .groupBy("DATE(e.created_at)")
        .orderBy('date', 'ASC')
        .getRawMany(),
      // 热门技能 Top 10
      this.skillRepo.createQueryBuilder('s')
        .leftJoin('s.stats', 'st')
        .select(['s.id', 's.name', 's.slug', 's.tags'])
        .addSelect('COALESCE(st.total_score, 5)::numeric(10,2)', 'score')
        .where('s.status = :status', { status: SkillStatus.PUBLISHED })
        .orderBy('score', 'DESC')
        .limit(10)
        .getRawMany(),
    ]);

    return {
      skills: { total: skillsTotal, published: publishedSkills },
      users: { total: usersTotal, last7d: users7d },
      teams: { total: teamsTotal },
      comments: { total: commentsTotal },
      trends: dailyEvents,
      topSkills: topSkills.map(s => ({
        id: s.s_id,
        name: s.s_name,
        slug: s.s_slug,
        tags: s.s_tags,
        score: Number(s.score),
      })),
    };
  }

  // ── 技能管理 ──────────────────────────────
  async listSkills(query: { page?: number; size?: number; search?: string; status?: string }) {
    const { page = 1, size = 20, search, status } = query;
    const qb = this.skillRepo.createQueryBuilder('s')
      .leftJoinAndSelect('s.owner_user', 'u')
      .leftJoinAndSelect('s.stats', 'st')
      .select(['s.id', 's.name', 's.slug', 's.short_summary', 's.tags', 's.status', 's.created_at', 's.updated_at'])
      .addSelect(['u.id', 'u.name', 'u.email'])
      .addSelect(['st.likes_total', 'st.downloads_total'])
      .orderBy('s.created_at', 'DESC')
      .take(size)
      .skip((page - 1) * size);

    if (search) {
      qb.andWhere('(s.name ILIKE :q OR s.slug ILIKE :q)', { q: `%${search}%` });
    }
    if (status) {
      qb.andWhere('s.status = :status', { status });
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, size };
  }

  async batchUpdateSkills(ids: string[], action: string, payload?: any) {
    if (!ids.length) return { ok: true, updated: 0 };

    switch (action) {
      case 'publish':
        await this.skillRepo.update({ id: In(ids) }, { status: SkillStatus.PUBLISHED });
        break;
      case 'unpublish':
        await this.skillRepo.update({ id: In(ids) }, { status: SkillStatus.ARCHIVED });
        break;
      case 'delete':
        await this.skillRepo.delete({ id: In(ids) });
        break;
      case 'retag':
        if (Array.isArray(payload?.tags)) {
          await this.skillRepo.update({ id: In(ids) }, { tags: payload.tags });
        }
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return { ok: true, updated: ids.length };
  }

  async updateSkill(id: string, data: { name?: string; short_summary?: string; tags?: string[]; cover_url?: string }) {
    const skill = await this.skillRepo.findOneBy({ id });
    if (!skill) throw new NotFoundException('Skill not found');
    await this.skillRepo.update(id, data);
    return { ok: true };
  }

  // ── 用户管理 ──────────────────────────────
  async listUsers(query: { page?: number; size?: number; search?: string }) {
    const { page = 1, size = 20, search } = query;
    const qb = this.userRepo.createQueryBuilder('u')
      .select(['u.id', 'u.email', 'u.name', 'u.role', 'u.created_at'])
      .orderBy('u.created_at', 'DESC')
      .take(size).skip((page - 1) * size);
    if (search) qb.andWhere('(u.name ILIKE :q OR u.email ILIKE :q)', { q: `%${search}%` });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, size };
  }

  async updateUser(id: string, data: { role?: string }) {
    const user = await this.userRepo.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');
    await this.userRepo.update(id, data);
    return { ok: true };
  }

  // ── 标签管理 ──────────────────────────────
  async getTags() {
    const skills = await this.skillRepo.find({ select: ['id', 'name', 'tags'], where: { status: SkillStatus.PUBLISHED } });
    const tagCounts: Record<string, number> = {};
    for (const s of skills) {
      for (const t of s.tags || []) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
    const tags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    return { tags, totalSkills: skills.length };
  }

  // ── 评论管理 ──────────────────────────────
  async listComments(query: { page?: number; size?: number }) {
    const { page = 1, size = 20 } = query;
    const [items, total] = await this.commentRepo.findAndCount({
      relations: ['user', 'skill'],
      select: { id: true, content: true, created_at: true, user: { id: true, name: true, email: true }, skill: { id: true, name: true, slug: true } },
      order: { created_at: 'DESC' } as any,
      take: size, skip: (page - 1) * size,
    });
    return { items, total, page, size };
  }

  async deleteComment(id: string) {
    const c = await this.commentRepo.findOneBy({ id });
    if (!c) throw new NotFoundException('Comment not found');
    await this.commentRepo.delete({ id });
    return { ok: true };
  }

  // ── 团队管理 ──────────────────────────────
  async listTeams(query: { page?: number; size?: number; search?: string }) {
    const { page = 1, size = 20, search } = query;
    const qb = this.teamRepo.createQueryBuilder('t')
      .leftJoin('t.members', 'm')
      .select(['t.id', 't.name', 't.description', 't.created_at'])
      .addSelect('COUNT(m.id)::int', 'member_count')
      .groupBy('t.id')
      .orderBy('t.created_at', 'DESC')
      .take(size).skip((page - 1) * size);
    if (search) qb.andWhere('t.name ILIKE :q', { q: `%${search}%` });
    const raw = await qb.getRawAndEntities();
    const items = raw.entities.map((t, i) => ({ ...t, member_count: Number((raw.raw[i] as any).member_count) || 0 }));
    return { items, total: items.length, page, size };
  }

  async updateTeam(id: string, data: { name?: string; description?: string }) {
    const team = await this.teamRepo.findOneBy({ id });
    if (!team) throw new NotFoundException('Team not found');
    await this.teamRepo.update(id, data);
    return { ok: true };
  }

  async deleteTeam(id: string) {
    const team = await this.teamRepo.findOneBy({ id });
    if (!team) throw new NotFoundException('Team not found');
    await this.teamRepo.delete({ id });
    return { ok: true };
  }

  // ── 操作日志 ──────────────────────────────
  async logAction(adminUserId: string, action: string, target_type?: string, target_id?: string, detail?: string) {
    return this.logRepo.save({ admin_user_id: adminUserId, action, target_type, target_id, detail });
  }

  async listLogs(query: { page?: number; size?: number }) {
    const { page = 1, size = 30 } = query;
    const [items, total] = await this.logRepo.findAndCount({
      order: { created_at: 'DESC' },
      take: size, skip: (page - 1) * size,
    });
    return { items, total, page, size };
  }

  // ── 系统设置 ──────────────────────────────
  getSettings() {
    return {
      siteName: 'SkillHub',
      version: '1.0',
      dbHost: process.env.DB_HOST?.replace(/\./g, '*') || '***',
      smtpUser: process.env.SMTP_USER || '(not set)',
      wechatEnabled: !!process.env.WECHAT_APPSECRET,
      wechatLoginEnabled: process.env.WECHAT_LOGIN_ENABLED === 'true',
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
      nodeEnv: process.env.NODE_ENV || 'development',
    };
  }
}
