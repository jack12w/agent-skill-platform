import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkillStats } from '../skills/skill-stats.entity';
import { LeaderboardType, LeaderboardPeriod } from '@platform/shared';

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(SkillStats)
    private statsRepository: Repository<SkillStats>,
  ) {}

  /**
   * 实时聚合，单一数据源 = skill_stats（recordEvent 每次点赞/下载都会维护，新鲜度无差别）。
   *
   * 分数公式（保留技能数的「对数衰减」，让少数高价值技能也能压过大量平庸技能，
   * 避免排名随技能数量线性飙升、看不出哪个技能有价值）：
   *   score = LOG(2, skill_count + 1) * 5 + 0.3 * likes + 0.3 * downloads
   * - 周榜：likes/downloads 取 skill_stats.likes_7d / downloads_7d；
   *         skill_count = 近 7 天上传的技能。
   * - 总榜：likes/downloads 取 skill_stats.likes_total / downloads_total；
   *         skill_count = 全部已发布技能。
   *
   * 团队条目额外暴露 member_count（成员总数）/ new_members（近 7 天新增，来自 team_members.joined_at）。
   */
  async getSnapshot(type: LeaderboardType, period: LeaderboardPeriod) {
    const isWeekly = period === LeaderboardPeriod.WEEKLY;
    const isTeam = type === LeaderboardType.TEAM;

    // 团队「对外展示」可见性：
    // - 团队榜：仅统计已对外展示的团队（私有团队不进公共榜单）
    // - 个人榜：排除挂在私有团队下的技能贡献（私有团队技能不公开）
    const teamFilter = isTeam
      ? "AND s.owner_team_id IN (SELECT id FROM teams WHERE is_public = true)"
      : "AND (s.owner_team_id IS NULL OR s.owner_team_id IN (SELECT id FROM teams WHERE is_public = true))";

    const subjectIdCol = isTeam ? 's.owner_team_id' : 's.owner_user_id';
    const subjectTable = isTeam ? 'teams' : 'users';

    // 周榜读 skill_stats.likes_7d/downloads_7d；总榜读 totals（不再现场扫 events）
    const likeCol = isWeekly ? 'st.likes_7d' : 'st.likes_total';
    const dlCol = isWeekly ? 'st.downloads_7d' : 'st.downloads_total';

    // 技能数：周榜仅统计近 7 天上传的技能
    const skillCountExpr = isWeekly
      ? "COUNT(DISTINCT s.id) FILTER (WHERE s.created_at >= NOW() - INTERVAL '7 days')"
      : 'COUNT(DISTINCT s.id)';

    // 团队额外维度：成员总数 / 近 7 天新增成员（每团队为常量，GROUP BY 后用 MAX 取回安全）
    const memberSelect = isTeam
      ? ', MAX(tm.new_members) AS new_members, MAX(tm.member_count) AS member_count'
      : '';
    const memberJoin = isTeam
      ? `LEFT JOIN (
           SELECT team_id,
             COUNT(*) FILTER (WHERE joined_at >= NOW() - INTERVAL '7 days') AS new_members,
             COUNT(*) AS member_count
           FROM team_members GROUP BY team_id
         ) tm ON tm.team_id = s.owner_team_id`
      : '';

    const rows: any[] = await this.statsRepository.query(
      `
      SELECT
        ${subjectIdCol}::text AS subject_id,
        COALESCE(subj.name, 'Anonymous') AS name,
        ${skillCountExpr} AS skill_count,
        COALESCE(SUM(${likeCol}), 0) AS likes,
        COALESCE(SUM(${dlCol}), 0) AS downloads,
        LOG(2, ${skillCountExpr} + 1) * 5
          + COALESCE(SUM(${likeCol}), 0) * 0.3
          + COALESCE(SUM(${dlCol}), 0) * 0.3 AS score
        ${memberSelect}
      FROM skills s
      LEFT JOIN skill_stats st ON st.skill_id = s.id
      ${memberJoin}
      LEFT JOIN ${subjectTable} subj ON subj.id = ${subjectIdCol}
      WHERE ${subjectIdCol} IS NOT NULL AND s.status = 'published' ${teamFilter}
      GROUP BY ${subjectIdCol}, subj.name
      HAVING ${skillCountExpr} > 0
        OR COALESCE(SUM(${likeCol}), 0) + COALESCE(SUM(${dlCol}), 0) > 0
      ORDER BY score DESC
      LIMIT 50
      `,
    );

    const data_json = rows.map((r: any) => {
      const row: any = {
        id: r.subject_id,
        name: r.name,
        skill_count: Number(r.skill_count) || 0,
        likes: Number(r.likes) || 0,
        downloads: Number(r.downloads) || 0,
        score: Number(r.score) || 0,
      };
      if (isTeam) {
        row.member_count = Number(r.member_count) || 0;
        row.new_members = Number(r.new_members) || 0;
      }
      return row;
    });

    return {
      type,
      period,
      snapshot_date: new Date().toISOString().split('T')[0],
      data_json,
    };
  }
}
