import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, ILike, In, Raw } from 'typeorm';
import { randomUUID } from 'crypto';
import { Skill } from './skill.entity';
import { SkillVersion } from './skill-version.entity';
import { Event } from './event.entity';
import { SkillStats } from './skill-stats.entity';
import { Comment } from './comment.entity';
import { TeamMember } from '../teams/team-member.entity';
import { OssService } from '../storage/oss.service';
import { EventType, SkillStatus, parseSkillMd } from '@platform/shared';
import AdmZip from 'adm-zip';

/** Strip base64 avatars (legacy data) — keep only OSS URLs */
function sanitizeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return null;   // base64 → strip
  return url;
}

@Injectable()
export class SkillsService {
  constructor(
    @InjectRepository(Skill)
    private skillRepository: Repository<Skill>,
    @InjectRepository(SkillVersion)
    private versionRepository: Repository<SkillVersion>,
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
    @InjectRepository(SkillStats)
    private statsRepository: Repository<SkillStats>,
    @InjectRepository(Comment)
    private commentRepository: Repository<Comment>,
    @InjectRepository(TeamMember)
    private teamMemberRepository: Repository<TeamMember>,
    private ossService: OssService,
  ) {}

  async findAll(query: { query?: string; tag?: string; tags?: string; sort?: string; page?: number; size?: number; owner?: string; owner_id?: string }, userId?: string) {
    const { query: q, tag, tags: tagsStr, sort, page = 1, size = 20, owner, owner_id } = query;
    const tagList = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];

    // For score-based sorts, count real events from the last 7 days / all-time
    // rather than relying on potentially-stale skill_stats columns.
    // weekly_score = 5 + likes * 0.1 + downloads * 0.1
    //
    // Uses QueryBuilder instead of raw SQL — entity column names (cover_url, tags, etc.)
    // are resolved from TypeORM metadata, eliminating column-name typos.
    if (sort === 'weekly' || sort === 'total') {
      const intervalExpr = sort === 'weekly'
        ? "NOW() - INTERVAL '7 days'"
        : "'1970-01-01'";

      const qb = this.skillRepository
        .createQueryBuilder('skill')
        .leftJoin('skill.stats', 'stats')
        .leftJoin('skill.owner_user', 'owner_user')
        .leftJoin('events', 'e', `skill.id = e.skill_id AND e.created_at >= ${intervalExpr}`)
        .leftJoin('skill_versions', 'lv', 'skill.published_version_id = lv.id')
        // Entity columns → resolved from TypeORM metadata (no typos)
        .select([
          'skill.id', 'skill.name', 'skill.slug', 'skill.short_summary', 'skill.content_md',
          'skill.cover_url', 'skill.tags', 'skill.status', 'skill.owner_user_id', 'skill.owner_team_id',
          'skill.created_at', 'skill.updated_at', 'skill.published_version_id',
        ])
        // Related entity columns
        .addSelect('stats.likes_total', 'likes_total')
        .addSelect('stats.downloads_total', 'downloads_total')
        .addSelect('stats.likes_7d', 'likes_7d')
        .addSelect('stats.downloads_7d', 'downloads_7d')
        .addSelect('stats.total_score', 'total_score')
        .addSelect('stats.weekly_score', 'weekly_score')
        .addSelect('owner_user.id', 'owner_id')
        .addSelect('owner_user.name', 'owner_name')
        .addSelect('owner_user.avatar_url', 'owner_avatar_url')
        .addSelect('lv.version', 'latest_version')
        // Computed aggregates (still raw, but no entity column names here)
        .addSelect("COUNT(CASE WHEN e.type = 'like' THEN 1 END)::int", '_likes')
        .addSelect("COUNT(CASE WHEN e.type = 'download' THEN 1 END)::int", '_downloads')
        .addSelect(
          "(5 + COUNT(CASE WHEN e.type = 'like' THEN 1 END) * 0.3 + COUNT(CASE WHEN e.type = 'download' THEN 1 END) * 0.3)::numeric(10,2)",
          '_score',
        )
        .where('skill.status = :status', { status: 'published' })
        .groupBy('skill.id')
        .addGroupBy('stats.skill_id')
        .addGroupBy('owner_user.id')
        .addGroupBy('lv.version')
        .addGroupBy('skill.published_version_id')
        .orderBy('_score', 'DESC')
        .limit(size)
        .offset((page - 1) * size);

      if (q) qb.andWhere('(skill.name ILIKE :q OR skill.short_summary ILIKE :q)', { q: `%${q}%` });
      if (tagList.length > 0) qb.andWhere('EXISTS (SELECT 1 FROM UNNEST(skill.tags) st JOIN UNNEST(ARRAY[:...tagList]) qt ON LOWER(st) = LOWER(qt))', { tagList });
      else if (tag) qb.andWhere('EXISTS (SELECT 1 FROM UNNEST(skill.tags) t WHERE LOWER(t) = LOWER(:tag))', { tag });
      if (owner_id) qb.andWhere('skill.owner_user_id = :owner_id', { owner_id });

      const rows: any[] = await qb.getRawMany();

      // getRawMany() returns keys prefixed with entity alias (e.g. skill_id, skill_name).
      // Map them to the shape expected by the frontend.
      const skills = rows.map((row: any) => ({
        id: row.skill_id,
        name: row.skill_name,
        slug: row.skill_slug,
        short_summary: row.skill_short_summary,
        content_md: row.skill_content_md,
        cover_url: row.skill_cover_url,
        tags: row.skill_tags,
        status: row.skill_status,
        owner_user_id: row.skill_owner_user_id,
        owner_team_id: row.skill_owner_team_id,
        published_version_id: row.skill_published_version_id || null,
        created_at: row.skill_created_at,
        updated_at: row.skill_updated_at,
        latest_version: row.latest_version ? { version: row.latest_version } : null,
        stats: {
          skill_id: row.skill_id,
          likes_total: Number(row.likes_total) || 0,
          downloads_total: Number(row.downloads_total) || 0,
          likes_7d: Number(row._likes) || 0,
          downloads_7d: Number(row._downloads) || 0,
          total_score: sort === 'total'
            ? Number(row._score)
            : (5 + (Number(row.likes_total) || 0) * 0.3 + (Number(row.downloads_total) || 0) * 0.3),
          weekly_score: sort === 'weekly'
            ? Number(row._score)
            : (5 + (Number(row.likes_7d) || 0) * 0.3 + (Number(row.downloads_7d) || 0) * 0.3),
          updated_at: row.skill_updated_at,
        },
        owner_user: {
          id: row.owner_id,
          name: row.owner_name,
          avatar_url: sanitizeAvatarUrl(row.owner_avatar_url),
        },
      }));
      await this.attachUpdateInfo(skills, userId);
      return skills;
    }

    // Default: sort by created_at (newest first)
    const baseWhere: any = {};
    if (tagList.length > 0) {
      baseWhere.tags = Raw(tags => `EXISTS (SELECT 1 FROM UNNEST(${tags}) st JOIN UNNEST(ARRAY[:...tagList]) qt ON LOWER(st) = LOWER(qt))`, { tagList });
    } else if (tag) {
      baseWhere.tags = Raw(tags => `EXISTS (SELECT 1 FROM UNNEST(${tags}) t WHERE LOWER(t) = LOWER(:tag))`, { tag });
    }
    if (owner !== 'me') baseWhere.status = SkillStatus.PUBLISHED;
    if (owner_id) baseWhere.owner_user_id = owner_id;

    const where = q
      ? [
          { ...baseWhere, name: ILike(`%${q}%`) },
          { ...baseWhere, short_summary: ILike(`%${q}%`) },
        ]
      : baseWhere;

    const skills = await this.skillRepository.find({
      where,
      relations: ['owner_user', 'stats', 'latest_version', 'published_version'],
      select: {
        owner_user: { id: true, name: true, avatar_url: true },
      },
      order: { created_at: 'DESC' as const },
      take: size,
      skip: (page - 1) * size,
    });

    const compute = (likes: number, downloads: number) => 5 + likes * 0.3 + downloads * 0.3;
    for (const s of skills) {
      // For non-owners (public list), show published_version as latest_version
      if (s.published_version) {
        (s as any).latest_version = s.published_version;
      }
      if (s.stats) {
        s.stats.total_score = compute(Number(s.stats.likes_total) || 0, Number(s.stats.downloads_total) || 0);
        s.stats.weekly_score = compute(Number(s.stats.likes_7d) || 0, Number(s.stats.downloads_7d) || 0);
      }
      // Strip base64 avatars (legacy data) — keep only OSS URLs
      if (s.owner_user) {
        (s.owner_user as any).avatar_url = sanitizeAvatarUrl(s.owner_user.avatar_url);
      }
    }

    await this.attachUpdateInfo(skills, userId);
    return skills;
  }

  /**
   * 检查技能名称是否与已有技能过于相似（pg_trgm trigram 匹配）
   * 返回相似度 ≥ 85% 的技能列表，按相似度降序排列
   */
  async checkSimilarName(name: string) {
    const normalized = name.trim();
    if (!normalized) return [];

    const result = await this.skillRepository
      .createQueryBuilder('skill')
      .select(['skill.name', 'skill.slug'])
      .addSelect(`similarity(skill.name, :name)`, 'similarity')
      .where(`similarity(skill.name, :name) >= 0.85`)
      .setParameter('name', normalized)
      .orderBy('similarity', 'DESC')
      .limit(3)
      .getRawMany();

    return result as { skill_name: string; skill_slug: string; similarity: number }[];
  }

  async createSkill(data: Partial<Skill>, userId: string) {
    // Validate owner_team_id: must be null or a team the user belongs to
    const teamId: string | null = (data.owner_team_id as string) || null;
    if (teamId) {
      const membership = await this.teamMemberRepository.findOne({
        where: { team_id: teamId, user_id: userId },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of that team');
      }
    }

    const name = (data.name || '').trim();
    if (!name) {
      throw new BadRequestException('Skill name is required');
    }

    // 同名相似度检测（pg_trgm）：阻止相似度 ≥ 85% 的重复技能
    const similar = await this.checkSimilarName(name);
    if (similar.length > 0) {
      const similarNames = similar.map(s => `"${s.skill_name}"（${Math.round(s.similarity * 100)}%）`).join('、');
      throw new BadRequestException(
        `技能名称与已有技能过于相似：${similarNames}`,
      );
    }

    // Use UUID as both id and slug so the URL matches the OSS storage path
    const id = randomUUID();
    const slug = id;

    // 从 Markdown 自动提取 short_summary（SEO/GEO 用）
    const contentMd = data.content_md || null;
    let shortSummary = data.short_summary || null;
    if (!shortSummary && contentMd) {
      // 去除 Markdown 标记后取前 160 字
      const plain = contentMd.replace(/^#{1,6}\s+/gm, '').replace(/[*_~`>\[\]()!|]/g, '').replace(/\n+/g, ' ').trim();
      shortSummary = plain.slice(0, 160).trim();
    }

    const skill = this.skillRepository.create({
      id,
      name,
      slug,
      summary: data.summary || contentMd || null,
      short_summary: shortSummary,
      content_md: contentMd,
      tags: (Array.isArray(data.tags) ? data.tags : []).flatMap((t: string) => t.split(/[，,]+/)).map((t: string) => t.trim()).filter(Boolean),
      cover_url: data.cover_url || null,
      owner_user_id: userId,
      owner_team_id: teamId,
      status: SkillStatus.PENDING,
    });
    const savedSkill = await this.skillRepository.save(skill);
    await this.statsRepository.save({ skill_id: savedSkill.id });
    return savedSkill;
  }

  async updateSkill(idOrSlug: string, data: Partial<Skill>, userId: string) {
    const skill = await this.findOne(idOrSlug, undefined, true);
    if (skill.owner_user_id !== userId) {
      throw new ForbiddenException('Only the owner can edit this skill');
    }

    // Whitelist editable fields — never let clients set id/owner/slug/status/etc.
    const patch: Partial<Skill> = {};
    if (typeof data.name === 'string' && data.name.trim()) patch.name = data.name.trim();
    if (typeof data.short_summary === 'string') patch.short_summary = data.short_summary;
    if (typeof data.summary === 'string') patch.summary = data.summary;
    if (typeof data.content_md === 'string') {
      patch.content_md = data.content_md;
      // 从 Markdown 自动提取 short_summary（如果没有手动设置）
      if (!data.short_summary && data.content_md) {
        const plain = data.content_md.replace(/^#{1,6}\s+/gm, '').replace(/[*_~`>\[\]()!|]/g, '').replace(/\n+/g, ' ').trim();
        patch.short_summary = plain.slice(0, 160).trim();
        patch.summary = data.content_md;
      }
    }
    if (Array.isArray(data.tags)) {
      // 保护「精选」标签：管理员添加的精选标签不可被用户编辑覆盖
      if (skill.tags?.includes('精选')) data.tags = [...data.tags.filter((t: string) => t !== '精选'), '精选'];
      patch.tags = data.tags;
    }
    if (typeof data.cover_url === 'string') patch.cover_url = data.cover_url;

    // owner_team_id: '' / null → detach; '<uuid>' → must be a team the user belongs to
    if ('owner_team_id' in data) {
      const teamId = (data.owner_team_id as string | null) || null;
      if (teamId) {
        const membership = await this.teamMemberRepository.findOne({
          where: { team_id: teamId, user_id: userId },
        });
        if (!membership) {
          throw new ForbiddenException('You are not a member of that team');
        }
      }
      patch.owner_team_id = teamId;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No editable fields provided');
    }

    await this.skillRepository.update({ id: skill.id }, patch);
    return this.findOne(skill.id, undefined, true);
  }

  async listVersions(skillId: string, userId?: string, isAdmin = false) {
    const skill = await this.findOne(skillId, undefined, true);
    const allVersions = await this.versionRepository.find({
      where: { skill_id: skill.id },
      order: { created_at: 'DESC' },
    });

    // Non-owners (and non-admins) should not see versions newer than the published version
    if (skill.published_version_id) {
      const isOwner = userId && (skill.owner_user_id === userId);
      if (!isOwner && !isAdmin) {
        const pubIdx = allVersions.findIndex(v => v.id === skill.published_version_id);
        if (pubIdx >= 0) {
          // Only return the published version and older versions
          return allVersions.slice(pubIdx);
        }
      }
    }

    return allVersions;
  }

  async createVersion(skillId: string, fileBuffer: Buffer, userId: string, notes?: string) {
    const skill = await this.findOne(skillId, undefined, true);
    if (skill.owner_user_id !== userId) throw new ForbiddenException('Not authorized');

    // Locate SKILL.md inside the zip — accept it anywhere, prefer the shallowest path.
    // (Case-insensitive, so SKILL.md / skill.md / Skill.md all work.)
    let meta: ReturnType<typeof parseSkillMd>;
    try {
      const zip = new AdmZip(fileBuffer);
      const candidates = zip
        .getEntries()
        .filter((e) => !e.isDirectory && /(^|\/)skill\.md$/i.test(e.entryName));

      if (candidates.length === 0) {
        throw new BadRequestException(
          'SKILL.md not found in zip. Your archive must contain a SKILL.md file (at the root or inside a single top-level folder) with YAML frontmatter declaring `name` and `version`.',
        );
      }

      candidates.sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length);
      const skillMdContent = candidates[0].getData().toString('utf8');
      meta = parseSkillMd(skillMdContent);
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`SKILL.md 解析失败：${e?.message || e}`);
    }

    // Enforce monotonic versioning: a given version number can only be uploaded once
    const dup = await this.versionRepository.findOne({
      where: { skill_id: skill.id, version: meta.version },
    });
    if (dup) {
      throw new BadRequestException(
        `Version ${meta.version} already exists for this skill. Bump the \`version\` field in SKILL.md.`,
      );
    }

    // Upload to OSS (falls back to mock URL if OSS env not configured)
    const objectKey = `skills/${skill.id}/${meta.version}.zip`;
    const package_url = await this.ossService.putBuffer(objectKey, fileBuffer);

    const version = this.versionRepository.create({
      skill_id: skill.id,
      version: meta.version,
      manifest_json: meta as any,
      package_url,
      size: fileBuffer.length,
      notes: notes?.trim() || null,
    });

    const savedVersion = await this.versionRepository.save(version);

    // For PUBLISHED skills, do NOT update short_summary/tags — those must wait
    // for admin approval so non-owners still see the old version's metadata.
    // For PENDING skills (first upload), update metadata so the admin can review it.
    const metadataUpdate: Partial<Skill> = {};
    if (skill.status !== SkillStatus.PUBLISHED) {
      if (meta.description) metadataUpdate.short_summary = meta.description;
      if (meta.tags && meta.tags.length) {
        const normalized = meta.tags.flatMap((t: string) => t.split(/[，,]+/)).map((t: string) => t.trim()).filter(Boolean);
        if (normalized.length > 0) {
          metadataUpdate.tags = [...new Set([...(skill.tags || []), ...normalized])];
        }
      }
    }

    await this.skillRepository.update(skill.id, {
      latest_version_id: savedVersion.id,
      // published_version_id stays unchanged — new version needs admin approval
      // before it becomes the public-facing version.
      // For first-time uploads on PENDING skills, published_version_id remains null.
      ...metadataUpdate,
      status: skill.status === SkillStatus.PUBLISHED ? SkillStatus.PUBLISHED : SkillStatus.PENDING,
    });

    await this.recordEvent(skill.id, EventType.SKILL_PUBLISH, userId);
    return savedVersion;
  }

  /**
   * Resolve a downloadable URL for a skill. If `versionId` is omitted,
   * returns the latest version's URL. Throws if the skill has no version yet.
   */
  async getDownloadUrl(skillId: string, versionId?: string, userId?: string, isAdmin = false) {
    const skill = await this.findOne(skillId, undefined, true);

    const isOwner = userId && skill.owner_user_id === userId;
    const canSeeLatest = isOwner || isAdmin;
    let version: SkillVersion | null = null;
    if (versionId) {
      version = await this.versionRepository.findOne({
        where: { id: versionId, skill_id: skill.id },
      });
      if (!version) throw new NotFoundException('Version not found');
    } else {
      // Owner / admin sees latest_version_id (including pending new versions);
      // non-owner sees published_version_id (only admin-approved versions).
      const liveVersionId = canSeeLatest
        ? skill.latest_version_id
        : (skill.published_version_id || skill.latest_version_id);
      if (liveVersionId) {
        version = await this.versionRepository.findOne({
          where: { id: liveVersionId },
        });
      }
    }

    if (!version) {
      throw new NotFoundException('No published versions available for this skill yet.');
    }

    return {
      url: version.package_url,
      version: version.version,
      version_id: version.id,
      size: version.size,
    };
  }

  /**
   * Proxy-download: fetch the zip from OSS server-side (no CORS) and return
   * the buffer + a human-readable filename for the Content-Disposition header.
   */
  async streamDownload(skillId: string, versionId?: string, userId?: string, isAdmin = false) {
    const result = await this.getDownloadUrl(skillId, versionId, userId, isAdmin);
    const skill = await this.findOne(skillId, undefined, true);
    const raw = `${skill.name || 'skill'}-v${result.version}.zip`;
    // Sanitize ASCII fallback (for old browsers), keep UTF-8 name in filename*= param
    const ascii = skill.name
      ? skill.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'skill'
      : 'skill';
    const filename = `${ascii}-v${result.version}.zip`;

    const res = await fetch(result.url);
    if (!res.ok) throw new NotFoundException('File not found on storage');
    const buffer = Buffer.from(await res.arrayBuffer());

    return { buffer, filename, raw };
  }

  async deleteVersion(skillId: string, versionId: string, userId: string) {
    const skill = await this.findOne(skillId, undefined, true);
    if (skill.owner_user_id !== userId) throw new ForbiddenException('Not authorized');

    const version = await this.versionRepository.findOne({ where: { id: versionId, skill_id: skill.id } });
    if (!version) throw new NotFoundException('Version not found');

    if (skill.latest_version_id === version.id) {
      throw new BadRequestException(
        'Cannot delete the latest version. Upload a newer version first, or delete the skill itself.',
      );
    }

    await this.ossService.deleteByUrl(version.package_url);
    await this.versionRepository.delete({ id: version.id });
    return { ok: true };
  }

  async deleteSkill(skillId: string, userId: string) {
    const skill = await this.findOne(skillId, undefined, true);
    if (skill.owner_user_id !== userId) {
      throw new ForbiddenException('Only the skill owner can delete this skill');
    }

    // 1. Delete all version packages from OSS
    const versions = await this.versionRepository.find({ where: { skill_id: skill.id } });
    for (const v of versions) {
      await this.ossService.deleteByUrl(v.package_url);
    }

    // 2. Delete all versions from DB
    if (versions.length > 0) {
      await this.versionRepository.delete({ skill_id: skill.id });
    }

    // 3. Delete stats
    await this.statsRepository.delete({ skill_id: skill.id });

    // 4. Delete events
    await this.eventRepository.delete({ skill_id: skill.id });

    // 5. Delete the skill itself
    await this.skillRepository.delete({ id: skill.id });

    return { ok: true };
  }

  async findOne(idOrSlug: string, userId?: string, skipStatusCheck = false, isAdmin = false) {
    // UUID format check (id), otherwise treat as slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const where = isUuid ? { id: idOrSlug } : { slug: idOrSlug };
    const skill = await this.skillRepository.findOne({
      where,
      relations: ['owner_user', 'owner_team', 'stats'],
      select: {
        owner_user: { id: true, name: true, avatar_url: true },
        owner_team: { id: true, name: true },
      },
    });
    if (!skill) throw new NotFoundException();

    // Non-owners (and non-admins) cannot view non-published skills (skip for internal service calls)
    if (!skipStatusCheck) {
      const isOwner = userId && (skill.owner_user_id === userId);
      if (!isOwner && !isAdmin && skill.status !== SkillStatus.PUBLISHED) {
        throw new NotFoundException();
      }
    }

    // Strip base64 avatar (legacy data)
    if (skill.owner_user) {
      (skill.owner_user as any).avatar_url = sanitizeAvatarUrl(skill.owner_user.avatar_url);
    }

    // Overwrite stats scores with canonical WEIGHTS formula in real time.
    if (skill.stats) {
      const likes = Number(skill.stats.likes_total) || 0;
      const downloads = Number(skill.stats.downloads_total) || 0;
      const likes7d = Number(skill.stats.likes_7d) || 0;
      const downloads7d = Number(skill.stats.downloads_7d) || 0;
      skill.stats.total_score = 5 + likes * 0.3 + downloads * 0.3;
      skill.stats.weekly_score = 5 + likes7d * 0.3 + downloads7d * 0.3;
    }

    // Non-owners (and non-admins) should see the published version, not a pending new version.
    // Swap latest_version_id / latest_version with published_version_id / published_version
    // so the frontend displays the approved version info.
    if (!skipStatusCheck && !isAdmin && skill.published_version_id) {
      const isOwner = userId && (skill.owner_user_id === userId);
      if (!isOwner) {
        skill.latest_version_id = skill.published_version_id;
        // Load the published version for the frontend display
        const pubVersion = await this.versionRepository.findOne({
          where: { id: skill.published_version_id },
        });
        if (pubVersion) {
          (skill as any).latest_version = pubVersion;
        }
      }
    }

    if (userId) {
      await this.attachUpdateInfo([skill], userId);
    }
    return skill;
  }

  /**
   * Attach has_update and user_downloaded_version to each skill result
   * by querying the user's latest download for each skill and comparing
   * with the current published version.
   */
  public async attachUpdateInfo(skills: any[], userId: string) {
    if (!skills.length || !userId) return;

    const skillIds = skills.map(s => s.id);

    // Batch-query the latest download event per skill for this user
    const downloads: any[] = await this.eventRepository
      .createQueryBuilder('e')
      .select('DISTINCT ON (e.skill_id) e.skill_id', 'skill_id')
      .addSelect("e.payload_json->>'version_id'", 'downloaded_version_id')
      .addSelect("e.payload_json->>'version'", 'downloaded_version')
      .where('e.type = :type', { type: 'download' })
      .andWhere('e.user_id = :userId', { userId })
      .andWhere('e.skill_id IN (:...skillIds)', { skillIds })
      .andWhere('e.payload_json IS NOT NULL')
      .orderBy('e.skill_id')
      .addOrderBy('e.created_at', 'DESC')
      .getRawMany();

    const downloadMap = new Map(downloads.map((d: any) => [d.skill_id, d]));

    for (const skill of skills) {
      const dl = downloadMap.get(skill.id);
      if (!dl || !dl.downloaded_version_id) {
        skill.has_update = false;
        skill.user_downloaded_version = null;
        continue;
      }

      // Don't show update badge for skills the user owns
      if (skill.owner_user_id === userId) {
        skill.has_update = false;
        skill.user_downloaded_version = null;
        continue;
      }

      // Get the live published version (normalize from both code paths)
      const liveVersionId = skill.published_version_id
        || (skill.published_version && skill.published_version.id)
        || null;

      if (!liveVersionId) {
        skill.has_update = false;
        skill.user_downloaded_version = dl.downloaded_version || null;
        continue;
      }

      skill.has_update = dl.downloaded_version_id !== liveVersionId;
      skill.user_downloaded_version = dl.downloaded_version || null;
    }
  }

  async recordEvent(skillId: string, type: EventType, userId?: string, ipHash?: string, payloadJson?: Record<string, any>) {
    // For LIKE: ensure per-user uniqueness (toggle would be cleaner, but for now we just dedupe)
    if (type === EventType.LIKE && userId) {
      const existing = await this.eventRepository.findOne({
        where: { skill_id: skillId, type: EventType.LIKE, user_id: userId },
      });
      if (existing) {
        // Already liked — just return current stats, do not increment again
        return existing;
      }
    }

    const event = this.eventRepository.create({
      skill_id: skillId,
      type,
      user_id: userId,
      ip_hash: ipHash,
      payload_json: payloadJson || null,
    });
    const saved = await this.eventRepository.save(event);

    // Ensure stats row exists
    let stats = await this.statsRepository.findOne({ where: { skill_id: skillId } });
    if (!stats) {
      stats = await this.statsRepository.save({ skill_id: skillId });
    }

    // Increment the matching counter column
    const incMap: Partial<Record<EventType, keyof SkillStats>> = {
      [EventType.LIKE]: 'likes_total',
      [EventType.DOWNLOAD]: 'downloads_total',
    };
    const incMap7d: Partial<Record<EventType, keyof SkillStats>> = {
      [EventType.LIKE]: 'likes_7d',
      [EventType.DOWNLOAD]: 'downloads_7d',
    };
    const column = incMap[type];
    const column7d = incMap7d[type];
    if (column) {
      await this.statsRepository.increment({ skill_id: skillId }, column as string, 1);
      // 同时更新 7 日内统计（新事件必定在 7 天窗口内）
      await this.statsRepository.increment({ skill_id: skillId }, column7d as string, 1);
      // Recompute both scores using the canonical WEIGHTS formula
      const fresh = await this.statsRepository.findOne({ where: { skill_id: skillId } });
      if (fresh) {
        const likes = Number(fresh.likes_total) || 0;
        const downloads = Number(fresh.downloads_total) || 0;
        const likes7d = Number(fresh.likes_7d) || 0;
        const downloads7d = Number(fresh.downloads_7d) || 0;
        const total = 5 + likes * 0.3 + downloads * 0.3;
        const weekly = 5 + likes7d * 0.3 + downloads7d * 0.3;
        await this.statsRepository.update({ skill_id: skillId }, { total_score: total, weekly_score: weekly });
      }
    }

    return saved;
  }

  async getGeoFeed(page: number, size: number) {
    const BASE_URL = process.env.PUBLIC_BASE_URL;
    const [skills, total] = await this.skillRepository.findAndCount({
      where: { status: SkillStatus.PUBLISHED },
      relations: ['owner_user', 'stats'],
      order: { updated_at: 'DESC' },
      take: size,
      skip: (page - 1) * size,
    });

    return {
      meta: {
        title: 'SkillDepot — AI Agent Skills Feed',
        description: 'Machine-readable feed of AI agent skills for GEO (Generative Engine Optimization).',
        total,
        page,
        page_size: size,
        last_updated: new Date().toISOString(),
        feed_url: `${BASE_URL}/api/ai/feed`,
      },
      items: skills.map((s) => ({
        id: s.id,
        title: s.name,
        summary: s.short_summary || s.summary || '',
        tags: s.tags || [],
        url: `${BASE_URL}/skills/${s.slug || s.id}`,
        author: s.owner_user ? { name: s.owner_user.name } : null,
        created_at: s.created_at,
        updated_at: s.updated_at,
        stats: {
          likes_total: Number(s.stats?.likes_total) || 0,
          downloads_total: Number(s.stats?.downloads_total) || 0,
          likes_7d: Number(s.stats?.likes_7d) || 0,
          downloads_7d: Number(s.stats?.downloads_7d) || 0,
          score_total: 5 + (Number(s.stats?.likes_total) || 0) * 0.1 + (Number(s.stats?.downloads_total) || 0) * 0.1,
          score_weekly: 5 + (Number(s.stats?.likes_7d) || 0) * 0.1 + (Number(s.stats?.downloads_7d) || 0) * 0.1,
        },
      })),
    };
  }

  // ── 评论 ─────────────────────────────────
  async getComments(skillId: string) {
    return this.commentRepository.find({
      where: { skill_id: skillId },
      relations: ['user'],
      order: { created_at: 'DESC' },
      select: {
        id: true, content: true, created_at: true,
        user: { id: true, name: true, avatar_url: true },
      },
    });
  }

  async createComment(skillId: string, userId: string, content: string) {
    if (!content?.trim()) throw new BadRequestException('Comment content is required');
    const skill = await this.skillRepository.findOne({ where: { id: skillId } });
    if (!skill) throw new NotFoundException('Skill not found');
    const comment = this.commentRepository.create({ skill_id: skillId, user_id: userId, content: content.trim() });
    const saved = await this.commentRepository.save(comment);
    return {
      ...saved,
      user: { id: userId }, // client will display current user info
    };
  }

  async deleteComment(commentId: string, userId: string) {
    const comment = await this.commentRepository.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.user_id !== userId) throw new ForbiddenException('Not your comment');
    await this.commentRepository.delete({ id: commentId });
    return { ok: true };
  }

  // ── 批量上传 ─────────────────────────────
  async batchUpload(files: { buffer: Buffer; originalname: string }[], userId: string, tags?: string[]) {
    const AdmZip = (await import('adm-zip')).default;
    const results: { name: string; ok: boolean; id?: string; error?: string }[] = [];

    for (const file of files) {
      try {
        // Parse SKILL.md from zip
        let meta: ReturnType<typeof parseSkillMd>;
        try {
          const zip = new AdmZip(file.buffer);
          const candidates = zip.getEntries().filter(e => !e.isDirectory && /(^|\/)skill\.md$/i.test(e.entryName));
          if (candidates.length === 0) throw new Error('SKILL.md not found');
          candidates.sort((a: any, b: any) => a.entryName.split('/').length - b.entryName.split('/').length);
          meta = parseSkillMd(candidates[0].getData().toString('utf8'));
        } catch (e: any) { throw new Error('SKILL.md 解析失败: ' + (e.message || String(e))); }

        // Check for similar name
        const similar = await this.checkSimilarName(meta.name);
        if (similar.length > 0) {
          throw new Error(`Name too similar to: ${similar.map(s => s.skill_name).join(', ')}`);
        }

        // Create skill
        const id = randomUUID();
        const skill = this.skillRepository.create({
          id, slug: id,
          name: meta.name,
          content_md: meta.description || null,
          short_summary: meta.description?.slice(0, 160) || null,
          tags: [...(meta.tags || []), ...(tags || [])],
          owner_user_id: userId,
          status: SkillStatus.PENDING,
        });
        const saved = await this.skillRepository.save(skill);
        await this.statsRepository.save({ skill_id: saved.id });

        // Upload version
        const objectKey = `skills/${saved.id}/1.0.0.zip`;
        const packageUrl = await this.ossService.putBuffer(objectKey, file.buffer);
        const version = this.versionRepository.create({
          skill_id: saved.id, version: meta.version || '1.0.0',
          manifest_json: meta as any, package_url: packageUrl, size: file.buffer.length,
        });
        const savedVersion = await this.versionRepository.save(version);
        await this.skillRepository.update(saved.id, { latest_version_id: savedVersion.id });

        results.push({ name: meta.name || file.originalname, ok: true, id: saved.id });
      } catch (err: any) {
        results.push({ name: file.originalname, ok: false, error: err.message || String(err) });
      }
    }
    return { results, total: files.length, success: results.filter(r => r.ok).length };
  }

  // ── 批量修复标签 ─────────────────────────
  async fixAllTags() {
    const skills = await this.skillRepository.find();
    const report: { id: string; name: string; before: string[]; after: string[] }[] = [];

    const OLD_TAG_MAP: Record<string, string> = {
      '国际站': '阿里国际站',
      '生意助手': '国际站生意助手',
    };

    for (const skill of skills) {
      if (!skill.tags?.length) continue;

      const normalized: string[] = [];

      for (const tag of skill.tags) {
        // 1. 中文/英文逗号拆分
        if (/[，,]/.test(tag)) {
          tag.split(/[，,]\s*/).map(t => t.trim()).filter(Boolean).forEach(t => normalized.push(t));
          continue;
        }

        // 2. 旧标签重命名
        if (OLD_TAG_MAP[tag]) {
          normalized.push(OLD_TAG_MAP[tag]);
          continue;
        }

        // 3. 纯英文标签转小写（中文标签保持原样）
        const trimmed = tag.trim();
        if (trimmed && /^[\x00-\x7F]+$/.test(trimmed)) {
          normalized.push(trimmed.toLowerCase());
        } else {
          normalized.push(trimmed);
        }
      }

      // 去重
      const unique = [...new Set(normalized)];

      if (JSON.stringify(unique) !== JSON.stringify(skill.tags)) {
        report.push({
          id: skill.id,
          name: skill.name,
          before: skill.tags,
          after: unique,
        });
        skill.tags = unique;
        await this.skillRepository.save(skill);
      }
    }

    return { fixed: report.length, report };
  }
}
