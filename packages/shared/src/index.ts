export const WEIGHTS = {
  skill: 5,         // 单技能基础分
  like: 0.3,        // 每个赞权重
  download: 0.3     // 每个下载权重
};

/**
 * Score decay for multi-skill subjects (users/teams).
 * Uses log₂(skill_count + 1) to dampen the advantage of uploading many low-quality skills.
 */
export function scoreSubject(skillCount: number, likes: number, downloads: number) {
  const skillScore = Math.log2(skillCount + 1) * WEIGHTS.skill;
  return skillScore + WEIGHTS.like * likes + WEIGHTS.download * downloads;
}

export enum SkillStatus {
  PENDING = 'pending',
  PUBLISHED = 'published',
  ARCHIVED = 'archived'
}

export enum EventType {
  SKILL_PUBLISH = 'skill_publish',
  DOWNLOAD = 'download',
  LIKE = 'like',
  VIEW = 'view'
}

export enum MemberRole {
  OWNER = 'owner',
  MAINTAINER = 'maintainer',
  VIEWER = 'viewer'
}

export enum LeaderboardType {
  PERSONAL = 'personal',
  TEAM = 'team'
}

export enum LeaderboardPeriod {
  WEEKLY = 'weekly',
  ALL = 'all'
}

/**
 * Single skill score calculation
 */
export function scoreSingleSkill(likes: number, downloads: number) {
  return WEIGHTS.skill + WEIGHTS.like * likes + WEIGHTS.download * downloads;
}

/**
 * Subject (User/Team) score calculation
 */
export * from './manifest.schema';
export * from './skill-md';
