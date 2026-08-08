import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Event } from './skills/event.entity';
import { SkillStats } from './skills/skill-stats.entity';
import { Skill } from './skills/skill.entity';

@Injectable()
export class StatsAggregationService {
  private readonly logger = new Logger(StatsAggregationService.name);

  constructor(
    private dataSource: DataSource,
    @InjectRepository(Skill) private skillRepo: Repository<Skill>,
    @InjectRepository(SkillStats) private statsRepo: Repository<SkillStats>,
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
}
