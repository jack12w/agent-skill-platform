export const WEIGHTS = {
  skill: 5,
  like: 0.1,
  download: 0.1
};

export enum SkillStatus {
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
