-- Add missing tables for hub features
-- Run this migration to fix missing database tables

-- Community leaderboard configuration
CREATE TABLE IF NOT EXISTS community_leaderboard_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,
    enabled_platforms JSONB DEFAULT '[]',
    min_watch_time_minutes INTEGER DEFAULT 60,
    min_message_count INTEGER DEFAULT 10,
    display_limit INTEGER DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_leaderboard_config_community ON community_leaderboard_config(community_id);

-- Module installations tracking
CREATE TABLE IF NOT EXISTS module_installations (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    module_id VARCHAR(100) NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE,
    config JSONB DEFAULT '{}',
    installed_at TIMESTAMPTZ DEFAULT NOW(),
    installed_by INTEGER,
    UNIQUE(community_id, module_id)
);

CREATE INDEX IF NOT EXISTS idx_module_installations_community ON module_installations(community_id);
CREATE INDEX IF NOT EXISTS idx_module_installations_module ON module_installations(module_id);

-- Browser source tokens
CREATE TABLE IF NOT EXISTS browser_source_tokens (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    source_type VARCHAR(50) NOT NULL,
    token VARCHAR(255) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_browser_source_tokens_community ON browser_source_tokens(community_id);
CREATE INDEX IF NOT EXISTS idx_browser_source_tokens_token ON browser_source_tokens(token);

-- Community domains
CREATE TABLE IF NOT EXISTS community_domains (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    domain VARCHAR(255) NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    verification_token VARCHAR(255),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_community_domains_community ON community_domains(community_id);
CREATE INDEX IF NOT EXISTS idx_community_domains_domain ON community_domains(domain);

-- Coordination table for stream status
CREATE TABLE IF NOT EXISTS coordination (
    id SERIAL PRIMARY KEY,
    entity_id INTEGER NOT NULL,
    channel_id VARCHAR(255),
    viewer_count INTEGER DEFAULT 0,
    stream_title TEXT,
    game_name VARCHAR(255),
    is_live BOOLEAN DEFAULT FALSE,
    started_at TIMESTAMPTZ,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_id)
);

CREATE INDEX IF NOT EXISTS idx_coordination_entity ON coordination(entity_id);
CREATE INDEX IF NOT EXISTS idx_coordination_live ON coordination(is_live);

-- AI insights table
CREATE TABLE IF NOT EXISTS ai_insights (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    insight_type VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    metadata JSONB DEFAULT '{}',
    data JSONB DEFAULT '{}',
    confidence_score DECIMAL(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
    priority VARCHAR(20) DEFAULT 'normal',
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_community ON ai_insights(community_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_type ON ai_insights(insight_type);
CREATE INDEX IF NOT EXISTS idx_ai_insights_status ON ai_insights(status);
CREATE INDEX IF NOT EXISTS idx_ai_insights_created ON ai_insights(created_at DESC);

-- Add missing column to suspected_bots table if it exists
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'suspected_bots') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'suspected_bots' AND column_name = 'last_detected_at') THEN
            ALTER TABLE suspected_bots ADD COLUMN last_detected_at TIMESTAMPTZ DEFAULT NOW();
        END IF;
    END IF;
END $$;

-- Add missing columns to announcement_broadcasts table if it exists
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'announcement_broadcasts') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'announcement_broadcasts' AND column_name = 'broadcast_at') THEN
            ALTER TABLE announcement_broadcasts ADD COLUMN broadcast_at TIMESTAMPTZ DEFAULT NOW();
        END IF;
    END IF;
END $$;

-- Comment
COMMENT ON TABLE community_leaderboard_config IS 'Configuration for community leaderboards';
COMMENT ON TABLE module_installations IS 'Tracks installed modules per community';
COMMENT ON TABLE browser_source_tokens IS 'Authentication tokens for OBS browser sources';
COMMENT ON TABLE community_domains IS 'Custom domains for communities';
COMMENT ON TABLE coordination IS 'Real-time stream coordination and status';
COMMENT ON TABLE ai_insights IS 'AI-generated insights and recommendations for communities';
