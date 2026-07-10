-- Base Tables for Agent Skill Platform

-- 1. Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    bio TEXT,
    tags TEXT[],
    wechat_openid TEXT,
    wechat_unionid TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Teams table
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    tags TEXT[],
    owner_user_id UUID NOT NULL REFERENCES users(id),
    is_public BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Team members table
CREATE TYPE member_role AS ENUM ('owner', 'maintainer', 'viewer');

CREATE TABLE IF NOT EXISTS team_members (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role member_role NOT NULL DEFAULT 'viewer',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

-- 4. Skills table
CREATE TYPE skill_status AS ENUM ('published', 'archived');

CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    owner_team_id UUID REFERENCES teams(id),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    summary TEXT,
    short_summary TEXT, -- GEO: 100-200 chars for AI
    content_md TEXT,    -- Markdown 正文（SEO/GEO 从此提取）
    io_schema JSONB,    -- GEO: JSON definition of inputs/outputs
    tags TEXT[],
    cover_url TEXT,
    status skill_status NOT NULL DEFAULT 'published',
    latest_version_id UUID,
    published_version_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Skill versions table
CREATE TABLE IF NOT EXISTS skill_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    manifest_json JSONB NOT NULL,
    package_url TEXT NOT NULL,
    checksum TEXT,
    size INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Update skills table to reference the latest version
ALTER TABLE skills ADD CONSTRAINT fk_latest_version FOREIGN KEY (latest_version_id) REFERENCES skill_versions(id) ON DELETE SET NULL;
ALTER TABLE skills ADD CONSTRAINT fk_published_version FOREIGN KEY (published_version_id) REFERENCES skill_versions(id) ON DELETE SET NULL;

-- 6. Events table (Raw behavior logs)
CREATE TYPE event_type AS ENUM ('skill_publish', 'download', 'like', 'view');

CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    type event_type NOT NULL,
    payload_json JSONB,
    ip_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Skill stats table (Aggregated)
CREATE TABLE IF NOT EXISTS skill_stats (
    skill_id UUID PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
    likes_total INTEGER DEFAULT 0,
    downloads_total INTEGER DEFAULT 0,
    likes_7d INTEGER DEFAULT 0,
    downloads_7d INTEGER DEFAULT 0,
    total_score NUMERIC(10, 2) DEFAULT 0,
    weekly_score NUMERIC(10, 2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Leaderboard snapshots table
CREATE TYPE leaderboard_type AS ENUM ('personal', 'team');
CREATE TYPE leaderboard_period AS ENUM ('weekly', 'all');

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type leaderboard_type NOT NULL,
    period leaderboard_period NOT NULL,
    snapshot_date DATE NOT NULL,
    data_json JSONB NOT NULL, -- The ordered list of subject scores
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug);
CREATE INDEX IF NOT EXISTS idx_events_skill_type ON events(skill_id, type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_skill_stats_total_score ON skill_stats(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_skill_stats_weekly_score ON skill_stats(weekly_score DESC);

-- pg_trgm extension for fuzzy name similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_skills_name_trgm ON skills USING GIN (name gin_trgm_ops);

-- 9. Comments table
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_skill ON comments(skill_id, created_at DESC);

-- 11. Admin audit log table
CREATE TABLE IF NOT EXISTS admin_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);

-- 12. Tag groups table
CREATE TABLE IF NOT EXISTS tag_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Page views table (website analytics)
CREATE TABLE IF NOT EXISTS page_views (
    id BIGSERIAL PRIMARY KEY,
    path TEXT NOT NULL,
    user_agent TEXT,
    ip_hash TEXT,
    referrer TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);

-- 14. User feedback table
CREATE TABLE IF NOT EXISTS feedbacks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type TEXT DEFAULT 'suggestion',
    name TEXT,
    email TEXT,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at DESC);

-- 15. Verification codes table
CREATE TABLE IF NOT EXISTS verification_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    used BOOLEAN DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 16. Subscriptions table (订阅功能)
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type VARCHAR(16) NOT NULL,
    target_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (subscriber_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_target ON subscriptions(target_type, target_id);

-- 17. Notifications table (站内通知)
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT DEFAULT 'subscription',
    subtype TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT,
    payload JSONB,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
