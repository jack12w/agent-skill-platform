import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaderboardSnapshot } from './leaderboard-snapshot.entity';
import { SkillStats } from '../skills/skill-stats.entity';
import { LeaderboardType, LeaderboardPeriod } from '@platform/shared';

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(LeaderboardSnapshot)
    private snapshotRepository: Repository<LeaderboardSnapshot>,
    @InjectRepository(SkillStats)
    private statsRepository: Repository<SkillStats>,
  ) {}

  /**
   * Real-time aggregation directly from skill_stats + users/teams.
   * Snapshot table is no longer used for reads (kept for future cron use).
   *
   * weekly: counts only events from last 7 days
   * all:    counts everything
   */
  async getSnapshot(type: LeaderboardType, period: LeaderboardPeriod) {
    const isWeekly = period === LeaderboardPeriod.WEEKLY;
    const isTeam = type === LeaderboardType.TEAM;

    // Build raw SQL — typeorm QueryBuilder is awkward across two grouping dimensions
    const subjectIdCol = isTeam ? 's.owner_team_id' : 's.owner_user_id';
    const subjectTable = isTeam ? 'teams' : 'users';

    // For weekly we recount likes/downloads from events table; for all we use stats columns
    let rows: Array<{
      subject_id: string;
      name: string;
      skill_count: string;
      likes: string;
      downloads: string;
      score: string;
    }>;

    if (isWeekly) {
      rows = await this.statsRepository.query(
        `
        WITH event_agg AS (
          SELECT
            e.skill_id,
            COUNT(DISTINCT e.user_id) FILTER (WHERE e.type = 'like')     AS likes,
            COUNT(*) FILTER (WHERE e.type = 'download')                   AS downloads
          FROM events e
          WHERE e.created_at >= NOW() - INTERVAL '7 days'
          GROUP BY e.skill_id
        )
        SELECT
          ${subjectIdCol}::text                              AS subject_id,
          COALESCE(subj.name, 'Anonymous')                   AS name,
          COUNT(DISTINCT s.id)                               AS skill_count,
          COALESCE(SUM(ea.likes), 0)                         AS likes,
          COALESCE(SUM(ea.downloads), 0)                     AS downloads,
          LOG(2, COUNT(DISTINCT s.id) + 1) * 5
            + COALESCE(SUM(ea.likes), 0) * 0.3
            + COALESCE(SUM(ea.downloads), 0) * 0.3           AS score
        FROM skills s
        LEFT JOIN event_agg ea     ON ea.skill_id = s.id
        LEFT JOIN ${subjectTable} subj ON subj.id = ${subjectIdCol}
        WHERE ${subjectIdCol} IS NOT NULL AND s.status = 'published'
        GROUP BY ${subjectIdCol}, subj.name
        ORDER BY score DESC
        LIMIT 50
        `,
      );
    } else {
      rows = await this.statsRepository.query(
        `
        SELECT
          ${subjectIdCol}::text                               AS subject_id,
          COALESCE(subj.name, 'Anonymous')                    AS name,
          COUNT(DISTINCT s.id)                                AS skill_count,
          COALESCE(SUM(st.likes_total), 0)                    AS likes,
          COALESCE(SUM(st.downloads_total), 0)                AS downloads,
          LOG(2, COUNT(DISTINCT s.id) + 1) * 5
            + COALESCE(SUM(st.likes_total), 0) * 0.3
            + COALESCE(SUM(st.downloads_total), 0) * 0.3      AS score
        FROM skills s
        LEFT JOIN skill_stats st   ON st.skill_id = s.id
        LEFT JOIN ${subjectTable} subj ON subj.id = ${subjectIdCol}
        WHERE ${subjectIdCol} IS NOT NULL AND s.status = 'published'
        GROUP BY ${subjectIdCol}, subj.name
        ORDER BY score DESC
        LIMIT 50
        `,
      );
    }

    // Frontend expects { data_json: [...] } shape (used to come from snapshot table)
    return {
      type,
      period,
      snapshot_date: new Date().toISOString().split('T')[0],
      data_json: rows.map((r) => ({
        id: r.subject_id,
        name: r.name,
        skill_count: Number(r.skill_count) || 0,
        likes: Number(r.likes) || 0,
        downloads: Number(r.downloads) || 0,
        score: Number(r.score) || 0,
      })),
    };
  }

  // Kept for future cron — not used by GET /leaderboard anymore
  async createSnapshot(type: LeaderboardType, period: LeaderboardPeriod) {
    const data = await this.getSnapshot(type, period);
    const snapshot = this.snapshotRepository.create({
      type,
      period,
      snapshot_date: data.snapshot_date,
      data_json: data.data_json,
    });
    return this.snapshotRepository.save(snapshot);
  }
}
