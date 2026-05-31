import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Event } from './skills/event.entity';
import { SkillStats } from './skills/skill-stats.entity';
import { Skill } from './skills/skill.entity';
import { LeaderboardSnapshot } from './leaderboard/leaderboard-snapshot.entity';
import { EventType, WEIGHTS, LeaderboardType, LeaderboardPeriod } from '@platform/shared';

@Injectable()
export class StatsAggregationService {
  private readonly logger = new Logger(StatsAggregationService.name);

  constructor(
    private dataSource: DataSource,
    @InjectRepository(Skill) private skillRepo: Repository<Skill>,
    @InjectRepository(SkillStats) private statsRepo: Repository<SkillStats>,
    @InjectRepository(LeaderboardSnapshot) private snapshotRepo: Repository<LeaderboardSnapshot>,
  ) {}

  /**
   * Aggregates raw events into skill_stats and calculates scores.
   * In production, this would be a high-performance SQL query.
   */
  async aggregateStats() {
    this.logger.log('Starting stats aggregation...');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Calculate total likes and downloads per skill
      await queryRunner.query(`
        UPDATE skill_stats ss
        SET 
          likes_total = (SELECT COUNT(DISTINCT user_id) FROM events WHERE skill_id = ss.skill_id AND type = 'like'),
          downloads_total = (SELECT COUNT(*) FROM events WHERE skill_id = ss.skill_id AND type = 'download'),
          likes_7d = (SELECT COUNT(DISTINCT user_id) FROM events WHERE skill_id = ss.skill_id AND type = 'like' AND created_at > NOW() - INTERVAL '7 days'),
          downloads_7d = (SELECT COUNT(*) FROM events WHERE skill_id = ss.skill_id AND type = 'download' AND created_at > NOW() - INTERVAL '7 days')
      `);

      // 2. Update scores based on the weights
      // Score = 5 + likes*0.3 + downloads*0.3
      await queryRunner.query(`
        UPDATE skill_stats
        SET 
          total_score = 5 + (likes_total * 0.3) + (downloads_total * 0.3),
          weekly_score = 5 + (likes_7d * 0.3) + (downloads_7d * 0.3)
      `);

      await queryRunner.commitTransaction();
      this.logger.log('Stats aggregation completed.');
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Stats aggregation failed', err.stack);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Generates a leaderboard snapshot for users or teams.
   */
  async createLeaderboardSnapshot(type: LeaderboardType, period: LeaderboardPeriod) {
    this.logger.log(`Creating ${period} ${type} leaderboard snapshot...`);
    
    let data;
    if (type === LeaderboardType.PERSONAL) {
      data = await this.dataSource.query(`
        SELECT 
          u.id, u.name,
          COUNT(s.id) as skill_count,
          SUM(ss.likes_total) as likes,
          SUM(ss.downloads_total) as downloads,
          (COUNT(s.id) * 5 + SUM(ss.likes_total) * 0.1 + SUM(ss.downloads_total) * 0.1) as score
        FROM users u
        JOIN skills s ON s.owner_user_id = u.id
        JOIN skill_stats ss ON ss.skill_id = s.id
        WHERE s.status = 'published'
        GROUP BY u.id, u.name
        ORDER BY score DESC
        LIMIT 100
      `);
    } else {
      data = await this.dataSource.query(`
        SELECT 
          t.id, t.name,
          COUNT(s.id) as skill_count,
          SUM(ss.likes_total) as likes,
          SUM(ss.downloads_total) as downloads,
          (COUNT(s.id) * 5 + SUM(ss.likes_total) * 0.1 + SUM(ss.downloads_total) * 0.1) as score
        FROM teams t
        JOIN skills s ON s.owner_team_id = t.id
        JOIN skill_stats ss ON ss.skill_id = s.id
        WHERE s.status = 'published'
        GROUP BY t.id, t.name
        ORDER BY score DESC
        LIMIT 100
      `);
    }

    const snapshot = this.snapshotRepo.create({
      type,
      period,
      snapshot_date: new Date().toISOString().split('T')[0],
      data_json: data,
    });

    await this.snapshotRepo.save(snapshot);
    this.logger.log('Leaderboard snapshot saved.');
  }
}
