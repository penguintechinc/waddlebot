-- WaddleBot Development Database Initialization
-- This script sets up the basic database structure for development

-- Create Kong database and user
-- Kong requires its own database separate from WaddleBot
CREATE DATABASE kong;

-- Create Kong user with password (must match KONG_PG_PASSWORD in docker-compose.yml)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'kong') THEN
        CREATE ROLE kong WITH LOGIN PASSWORD 'kong_db_pass_change_me';
    END IF;
END
$$;

-- Grant all privileges on kong database to kong user
GRANT ALL PRIVILEGES ON DATABASE kong TO kong;

-- Connect to kong database to grant schema permissions
\c kong

-- Grant schema permissions to kong user
GRANT ALL ON SCHEMA public TO kong;
ALTER SCHEMA public OWNER TO kong;

-- Switch to WaddleBot database for remaining setup
\c waddlebot

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Create schemas for different modules
CREATE SCHEMA IF NOT EXISTS public;
CREATE SCHEMA IF NOT EXISTS portal;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS router;

-- Set default search path
ALTER DATABASE waddlebot SET search_path TO public, portal, identity, router;

-- Create a development user with appropriate permissions
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'waddlebot_dev') THEN
        CREATE ROLE waddlebot_dev WITH LOGIN PASSWORD 'dev123';
    END IF;
END
$$;

-- Grant permissions
GRANT CONNECT ON DATABASE waddlebot TO waddlebot_dev;
GRANT USAGE ON SCHEMA public, portal, identity, router TO waddlebot_dev;
GRANT CREATE ON SCHEMA public, portal, identity, router TO waddlebot_dev;

-- Create indexes for common query patterns
-- These will be created by py4web/pydal as needed, but we can prepare some common ones

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Insert some development data (optional)
-- This would be handled by the application initialization

-- Platform configuration table (for storing OAuth credentials)
CREATE TABLE IF NOT EXISTS platform_configs (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(50) NOT NULL,
    config_key VARCHAR(100) NOT NULL,
    config_value TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER,
    UNIQUE(platform, config_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_configs_platform ON platform_configs(platform);

-- Unified Users table (local login centric)
CREATE TABLE IF NOT EXISTS hub_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE,
    username VARCHAR(100),
    password_hash VARCHAR(255),
    avatar_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_super_admin BOOLEAN DEFAULT FALSE,
    email_verified BOOLEAN DEFAULT FALSE,
    email_verification_token VARCHAR(100),
    email_verification_expires TIMESTAMP,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Global hub settings
CREATE TABLE IF NOT EXISTS hub_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER REFERENCES hub_users(id)
);

CREATE INDEX IF NOT EXISTS idx_hub_users_email ON hub_users(email);
CREATE INDEX IF NOT EXISTS idx_hub_users_username ON hub_users(username);

-- Platform identities linked to users
CREATE TABLE IF NOT EXISTS hub_user_identities (
    id SERIAL PRIMARY KEY,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    platform_email VARCHAR(255),
    avatar_url TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMP,
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_user_identities_user ON hub_user_identities(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_hub_user_identities_platform ON hub_user_identities(platform, platform_user_id);

-- User profiles with about me and visibility settings
CREATE TABLE IF NOT EXISTS hub_user_profiles (
    id SERIAL PRIMARY KEY,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE UNIQUE,
    display_name VARCHAR(100),
    bio TEXT,
    location VARCHAR(100),
    location_city VARCHAR(100),
    location_state VARCHAR(100),
    location_country VARCHAR(100),
    website_url VARCHAR(255),
    custom_avatar_url TEXT,
    banner_url TEXT,
    social_links JSONB DEFAULT '{}',
    visibility VARCHAR(30) DEFAULT 'shared_communities',
    show_activity BOOLEAN DEFAULT TRUE,
    show_communities BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hub_user_profiles_user ON hub_user_profiles(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_hub_user_profiles_visibility ON hub_user_profiles(visibility);

COMMENT ON TABLE hub_user_profiles IS 'Extended user profile with about me and visibility settings';
COMMENT ON COLUMN hub_user_profiles.visibility IS 'Profile visibility: public, registered, shared_communities, community_leaders';
COMMENT ON COLUMN hub_user_profiles.custom_avatar_url IS 'User-uploaded avatar, overrides platform avatar';
COMMENT ON COLUMN hub_user_profiles.social_links IS 'DEPRECATED - linked platforms displayed from hub_user_identities instead';
COMMENT ON COLUMN hub_user_profiles.location_city IS 'User city for profile display';
COMMENT ON COLUMN hub_user_profiles.location_state IS 'User state/province for profile display';
COMMENT ON COLUMN hub_user_profiles.location_country IS 'User country code (ISO 3166-1 alpha-2) for profile display';

-- OAuth state storage for CSRF protection
CREATE TABLE IF NOT EXISTS hub_oauth_states (
    id SERIAL PRIMARY KEY,
    state VARCHAR(100) UNIQUE NOT NULL,
    mode VARCHAR(20) DEFAULT 'login',
    platform VARCHAR(50),
    user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hub_oauth_states_state ON hub_oauth_states(state);

-- Sessions table
CREATE TABLE IF NOT EXISTS hub_sessions (
    id SERIAL PRIMARY KEY,
    session_token TEXT UNIQUE NOT NULL,
    user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform_username VARCHAR(100),
    avatar_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hub_sessions_token ON hub_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_hub_sessions_user ON hub_sessions(user_id);

-- Temp passwords for invites
CREATE TABLE IF NOT EXISTS hub_temp_passwords (
    id SERIAL PRIMARY KEY,
    community_id INTEGER,
    user_identifier VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    force_oauth_link BOOLEAN DEFAULT FALSE,
    is_used BOOLEAN DEFAULT FALSE,
    used_at TIMESTAMP,
    linked_oauth_platform VARCHAR(50),
    linked_oauth_user_id VARCHAR(100),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES hub_users(id)
);

CREATE INDEX IF NOT EXISTS idx_hub_temp_passwords_identifier ON hub_temp_passwords(user_identifier);

-- Communities table
CREATE TABLE IF NOT EXISTS communities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(200),
    description TEXT,
    about_extended TEXT,
    social_links JSONB DEFAULT '{}',
    website_url VARCHAR(500),
    discord_invite_url VARCHAR(500),
    platform VARCHAR(50) NOT NULL,
    platform_server_id VARCHAR(255),
    owner_id INTEGER REFERENCES hub_users(id),
    owner_name VARCHAR(255),
    member_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_public BOOLEAN DEFAULT TRUE,
    is_global BOOLEAN DEFAULT FALSE,
    join_mode VARCHAR(20) DEFAULT 'open',
    visibility VARCHAR(20) DEFAULT 'public',
    config JSONB DEFAULT '{}',
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    deleted_by VARCHAR(255)
);
COMMENT ON COLUMN communities.join_mode IS 'open = anyone can join, approval = requires admin/mod approval, invite = invite only';
COMMENT ON COLUMN communities.is_global IS 'Global community that all users are auto-added to. Cannot be deleted.';
COMMENT ON COLUMN communities.visibility IS 'Profile visibility: public, registered, members_only';
COMMENT ON COLUMN communities.about_extended IS 'Extended about section for community profile page';
COMMENT ON COLUMN communities.social_links IS 'JSON object: {twitter, youtube, tiktok, instagram, etc}';

CREATE INDEX IF NOT EXISTS idx_communities_name ON communities(name);
CREATE INDEX IF NOT EXISTS idx_communities_platform ON communities(platform, platform_server_id);
CREATE INDEX IF NOT EXISTS idx_communities_active ON communities(is_active, is_public);
CREATE INDEX IF NOT EXISTS idx_communities_visibility ON communities(visibility);

-- Community members
CREATE TABLE IF NOT EXISTS community_members (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'member',
    reputation INTEGER DEFAULT 600,
    is_active BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, user_id)
);
COMMENT ON COLUMN community_members.reputation IS 'Credit score style reputation (300-850 range, starts at 600)';

CREATE INDEX IF NOT EXISTS idx_community_members_community ON community_members(community_id);
CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members(user_id);

-- Join requests for approval workflow
CREATE TABLE IF NOT EXISTS join_requests (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    message TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    reviewed_by INTEGER REFERENCES hub_users(id),
    reviewed_at TIMESTAMP,
    review_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, user_id)
);
COMMENT ON COLUMN join_requests.status IS 'pending, approved, rejected';
CREATE INDEX IF NOT EXISTS idx_join_requests_community ON join_requests(community_id, status);
CREATE INDEX IF NOT EXISTS idx_join_requests_user ON join_requests(user_id);

-- Community Servers (linked Discord/Twitch/Slack servers)
CREATE TABLE IF NOT EXISTS community_servers (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_server_id VARCHAR(255) NOT NULL,
    platform_server_name VARCHAR(255),
    link_type VARCHAR(20) DEFAULT 'server',
    added_by INTEGER REFERENCES hub_users(id),
    approved_by INTEGER REFERENCES hub_users(id),
    status VARCHAR(20) DEFAULT 'pending',
    is_primary BOOLEAN DEFAULT FALSE,
    config JSONB DEFAULT '{}',
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, platform, platform_server_id)
);
COMMENT ON COLUMN community_servers.link_type IS 'server = whole server, channel = specific channels only';
COMMENT ON COLUMN community_servers.status IS 'pending, approved, rejected';
CREATE INDEX IF NOT EXISTS idx_community_servers_community ON community_servers(community_id, status);
CREATE INDEX IF NOT EXISTS idx_community_servers_platform ON community_servers(platform, platform_server_id);

-- Community Server Channels (for Discord/Slack specific channels)
CREATE TABLE IF NOT EXISTS community_server_channels (
    id SERIAL PRIMARY KEY,
    community_server_id INTEGER REFERENCES community_servers(id) ON DELETE CASCADE,
    platform_channel_id VARCHAR(255) NOT NULL,
    platform_channel_name VARCHAR(255),
    channel_type VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_server_id, platform_channel_id)
);
CREATE INDEX IF NOT EXISTS idx_community_server_channels_server ON community_server_channels(community_server_id);

-- Server Link Requests (for non-admin users requesting to link their server)
CREATE TABLE IF NOT EXISTS server_link_requests (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_server_id VARCHAR(255) NOT NULL,
    platform_server_name VARCHAR(255),
    requested_by INTEGER REFERENCES hub_users(id),
    status VARCHAR(20) DEFAULT 'pending',
    reviewed_by INTEGER REFERENCES hub_users(id),
    reviewed_at TIMESTAMP,
    review_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_server_link_requests_community ON server_link_requests(community_id, status);

-- Mirror Groups (cross-platform chat mirroring configuration)
CREATE TABLE IF NOT EXISTS mirror_groups (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    config JSONB DEFAULT '{"messageTypes": ["chat"]}',
    created_by INTEGER REFERENCES hub_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON COLUMN mirror_groups.config IS 'Contains messageTypes array: chat, sub, follow, raid, donation, cheer';
CREATE INDEX IF NOT EXISTS idx_mirror_groups_community ON mirror_groups(community_id, is_active);

-- Mirror Group Members (channels in a mirror group)
CREATE TABLE IF NOT EXISTS mirror_group_members (
    id SERIAL PRIMARY KEY,
    mirror_group_id INTEGER REFERENCES mirror_groups(id) ON DELETE CASCADE,
    community_server_id INTEGER REFERENCES community_servers(id) ON DELETE CASCADE,
    community_server_channel_id INTEGER REFERENCES community_server_channels(id) ON DELETE SET NULL,
    direction VARCHAR(20) DEFAULT 'bidirectional',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(mirror_group_id, community_server_id, community_server_channel_id)
);
COMMENT ON COLUMN mirror_group_members.direction IS 'send_only, receive_only, bidirectional';
CREATE INDEX IF NOT EXISTS idx_mirror_group_members_group ON mirror_group_members(mirror_group_id);
CREATE INDEX IF NOT EXISTS idx_mirror_group_members_server ON mirror_group_members(community_server_id);

-- ============================================================================
-- USER ACTIVITY TRACKING & LEADERBOARD TABLES
-- ============================================================================

-- Track individual watch sessions (viewer presence on streams)
CREATE TABLE IF NOT EXISTS activity_watch_sessions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    channel_id VARCHAR(100) NOT NULL,
    session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_end TIMESTAMPTZ,
    duration_seconds INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON COLUMN activity_watch_sessions.hub_user_id IS 'NULL if platform user not linked to hub account';
COMMENT ON COLUMN activity_watch_sessions.duration_seconds IS 'Calculated when session ends';

CREATE INDEX IF NOT EXISTS idx_watch_sessions_community ON activity_watch_sessions(community_id);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_user ON activity_watch_sessions(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_platform_user ON activity_watch_sessions(platform, platform_user_id);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_active ON activity_watch_sessions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_watch_sessions_time ON activity_watch_sessions(session_start);

-- Track message events for counting
CREATE TABLE IF NOT EXISTS activity_message_events (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    channel_id VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON COLUMN activity_message_events.platform IS 'twitch, kick, youtube, discord, slack, hub';

CREATE INDEX IF NOT EXISTS idx_message_events_community ON activity_message_events(community_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_events_user ON activity_message_events(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_message_events_platform_user ON activity_message_events(platform, platform_user_id);
CREATE INDEX IF NOT EXISTS idx_message_events_time ON activity_message_events(created_at);

-- Pre-aggregated daily stats for efficient leaderboard queries
CREATE TABLE IF NOT EXISTS activity_stats_daily (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform_user_id VARCHAR(100),
    platform_username VARCHAR(100),
    stat_date DATE NOT NULL,
    watch_time_seconds INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, COALESCE(hub_user_id, -1), COALESCE(platform_user_id, ''), stat_date)
);
COMMENT ON TABLE activity_stats_daily IS 'Aggregated daily stats per user per community';

CREATE INDEX IF NOT EXISTS idx_stats_daily_community_date ON activity_stats_daily(community_id, stat_date);
CREATE INDEX IF NOT EXISTS idx_stats_daily_user ON activity_stats_daily(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_stats_daily_leaderboard ON activity_stats_daily(community_id, stat_date, watch_time_seconds DESC);
CREATE INDEX IF NOT EXISTS idx_stats_daily_messages ON activity_stats_daily(community_id, stat_date, message_count DESC);

-- Community leaderboard configuration
CREATE TABLE IF NOT EXISTS community_leaderboard_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE UNIQUE,
    enabled_platforms JSONB DEFAULT '["twitch", "kick", "youtube", "discord"]',
    watch_time_enabled BOOLEAN DEFAULT true,
    messages_enabled BOOLEAN DEFAULT true,
    public_leaderboard BOOLEAN DEFAULT true,
    min_watch_time_minutes INTEGER DEFAULT 5,
    min_message_count INTEGER DEFAULT 10,
    display_limit INTEGER DEFAULT 25,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE community_leaderboard_config IS 'Per-community leaderboard settings';
COMMENT ON COLUMN community_leaderboard_config.enabled_platforms IS 'Array of platforms to include in leaderboards';
COMMENT ON COLUMN community_leaderboard_config.min_watch_time_minutes IS 'Minimum watch time to appear on leaderboard';
COMMENT ON COLUMN community_leaderboard_config.min_message_count IS 'Minimum messages to appear on leaderboard';

-- ============================================================================
-- REPUTATION SYSTEM TABLES
-- FICO-style credit score system (300-850 range, default 600)
-- ============================================================================

-- Reputation events audit log - tracks all score changes
CREATE TABLE IF NOT EXISTS reputation_events (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    score_change DECIMAL(6,2) NOT NULL,
    score_before INTEGER NOT NULL,
    score_after INTEGER NOT NULL,
    reason VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE reputation_events IS 'Audit log of all reputation score changes';
COMMENT ON COLUMN reputation_events.event_type IS 'Type: chatMessage, command, follow, subscription, warn, timeout, kick, ban, etc.';
COMMENT ON COLUMN reputation_events.score_change IS 'Points added (positive) or removed (negative)';

CREATE INDEX IF NOT EXISTS idx_rep_events_community ON reputation_events(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rep_events_user ON reputation_events(hub_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rep_events_platform_user ON reputation_events(platform, platform_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rep_events_type ON reputation_events(event_type, created_at DESC);

-- Global reputation - cross-community aggregate score
CREATE TABLE IF NOT EXISTS reputation_global (
    id SERIAL PRIMARY KEY,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE UNIQUE,
    score INTEGER DEFAULT 600 NOT NULL CHECK (score >= 300 AND score <= 850),
    total_events INTEGER DEFAULT 0,
    last_event_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE reputation_global IS 'Global reputation score aggregated across all communities';
COMMENT ON COLUMN reputation_global.score IS 'FICO-style score: 300 (poor) to 850 (exceptional), default 600';

CREATE INDEX IF NOT EXISTS idx_rep_global_score ON reputation_global(score DESC);

-- Community reputation configuration - weight settings (PREMIUM feature for customization)
CREATE TABLE IF NOT EXISTS community_reputation_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,
    is_premium BOOLEAN DEFAULT FALSE,
    -- Positive activity weights
    chat_message DECIMAL(5,3) DEFAULT 0.01,
    command_usage DECIMAL(5,3) DEFAULT -0.1,
    giveaway_entry DECIMAL(5,2) DEFAULT -1.0,  -- Larger penalty to dissuade giveaway bots
    follow DECIMAL(5,2) DEFAULT 1.0,
    subscription DECIMAL(5,2) DEFAULT 5.0,
    subscription_tier2 DECIMAL(5,2) DEFAULT 10.0,
    subscription_tier3 DECIMAL(5,2) DEFAULT 20.0,
    gift_subscription DECIMAL(5,2) DEFAULT 3.0,
    donation_per_dollar DECIMAL(5,3) DEFAULT 1.0,
    cheer_per_100bits DECIMAL(5,2) DEFAULT 1.0,
    raid DECIMAL(5,2) DEFAULT 2.0,
    boost DECIMAL(5,2) DEFAULT 5.0,
    -- Moderation penalty weights (negative values)
    warn DECIMAL(5,2) DEFAULT -25.0,
    timeout DECIMAL(5,2) DEFAULT -50.0,
    kick DECIMAL(5,2) DEFAULT -75.0,
    ban DECIMAL(5,2) DEFAULT -200.0,
    -- Policy settings
    auto_ban_enabled BOOLEAN DEFAULT FALSE,
    auto_ban_threshold INTEGER DEFAULT 450 CHECK (auto_ban_threshold >= 300 AND auto_ban_threshold <= 850),
    starting_score INTEGER DEFAULT 600 CHECK (starting_score >= 300 AND starting_score <= 850),
    min_score INTEGER DEFAULT 300,
    max_score INTEGER DEFAULT 850,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE community_reputation_config IS 'Per-community reputation weight configuration (customization is PREMIUM)';
COMMENT ON COLUMN community_reputation_config.is_premium IS 'If false, uses default weights regardless of stored values';
COMMENT ON COLUMN community_reputation_config.auto_ban_enabled IS 'Automatically ban users whose score falls below threshold';
COMMENT ON COLUMN community_reputation_config.auto_ban_threshold IS 'Score at which auto-ban triggers (default 450)';

-- ============================================================================

-- Coordination table for tracking live streams and platform connections
CREATE TABLE IF NOT EXISTS coordination (
    id SERIAL PRIMARY KEY,
    entity_id VARCHAR(255) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    server_id VARCHAR(255),
    channel_id VARCHAR(255),
    channel_name VARCHAR(255),
    is_live BOOLEAN DEFAULT FALSE,
    viewer_count INTEGER DEFAULT 0,
    live_since TIMESTAMP,
    stream_title TEXT,
    game_name VARCHAR(255),
    thumbnail_url TEXT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_coordination_platform ON coordination(platform);
CREATE INDEX IF NOT EXISTS idx_coordination_live ON coordination(is_live);
CREATE INDEX IF NOT EXISTS idx_coordination_server ON coordination(server_id);

-- NOTE: Default admin user is created by the hub module on startup
-- This ensures the password hash is compatible with the Node.js bcrypt implementation

-- Create global community (all users auto-added, cannot be deleted)
INSERT INTO communities (name, display_name, description, platform, is_active, is_public, is_global, join_mode, config)
VALUES (
    'waddlebot-global',
    'WaddleBot Global',
    'The global WaddleBot community. All users are automatically members.',
    'hub',
    true,
    true,
    true,
    'open',
    '{"logo_url": null, "banner_url": null, "is_system": true}'
)
ON CONFLICT (name) DO NOTHING;

-- NOTE: Admin user is added to global community by the hub module when it creates the admin user
-- All new users are automatically added to the global community via authController.js

-- ============================================================================
-- AI RESEARCHER MODULE TABLES
-- ============================================================================

-- Enable pgvector for semantic search and embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Configuration per community
CREATE TABLE IF NOT EXISTS ai_researcher_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER UNIQUE REFERENCES communities(id) ON DELETE CASCADE,
    is_premium BOOLEAN DEFAULT FALSE,

    -- AI Provider Configuration
    ai_provider VARCHAR(50) DEFAULT 'ollama',           -- ollama/openai/anthropic
    ai_model VARCHAR(100) DEFAULT 'tinyllama',

    -- Research Command Settings
    research_enabled BOOLEAN DEFAULT TRUE,
    response_destination VARCHAR(20) DEFAULT 'same_chat', -- same_chat/dm/dedicated_channel
    dedicated_channel_id VARCHAR(255),

    -- Rate Limits
    rate_limit_per_user_hour INTEGER DEFAULT 5,
    rate_limit_per_community_hour INTEGER DEFAULT 50,

    -- Context/Memory Settings (mem0)
    context_tracking_enabled BOOLEAN DEFAULT TRUE,
    context_update_interval_minutes INTEGER DEFAULT 10,
    context_update_message_threshold INTEGER DEFAULT 10000,

    -- Summary Settings
    stream_summary_enabled BOOLEAN DEFAULT TRUE,
    weekly_summary_enabled BOOLEAN DEFAULT TRUE,
    weekly_summary_day INTEGER DEFAULT 0,               -- 0=Sunday
    weekly_summary_hour INTEGER DEFAULT 9,              -- UTC hour

    -- Bot Detection Settings
    bot_detection_enabled BOOLEAN DEFAULT FALSE,        -- Premium feature
    bot_detection_after_stream BOOLEAN DEFAULT TRUE,
    bot_detection_weekly BOOLEAN DEFAULT TRUE,
    bot_confidence_alert_threshold INTEGER DEFAULT 85,  -- Auto-alert at this %

    -- Webhook Integration
    webhook_url VARCHAR(500),
    webhook_events TEXT[] DEFAULT '{}',                 -- stream_summary, weekly_rollup, bot_alert

    -- Topic Categories
    blocked_topics TEXT[] DEFAULT '{politics,medical,legal,financial}',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_researcher_config_community ON ai_researcher_config(community_id);

COMMENT ON TABLE ai_researcher_config IS 'Per-community AI researcher module configuration';
COMMENT ON COLUMN ai_researcher_config.is_premium IS 'Premium tier enables additional features and customization';
COMMENT ON COLUMN ai_researcher_config.response_destination IS 'Where to send research responses: same_chat, dm, or dedicated_channel';
COMMENT ON COLUMN ai_researcher_config.blocked_topics IS 'Array of blocked topic categories for safety';

-- Community context snapshots (legacy + embedding for RAG)
CREATE TABLE IF NOT EXISTS ai_community_context (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    context_data JSONB NOT NULL,                        -- topics, games, sentiment, personalities
    embedding_vector VECTOR(1536),                      -- For semantic search
    message_count_since_last INTEGER DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_context_community ON ai_community_context(community_id);
CREATE INDEX IF NOT EXISTS idx_ai_context_updated ON ai_community_context(updated_at DESC);

COMMENT ON TABLE ai_community_context IS 'Compressed context snapshots with embeddings for semantic search';
COMMENT ON COLUMN ai_community_context.context_data IS 'JSON containing topics, games, sentiment analysis, user personalities';
COMMENT ON COLUMN ai_community_context.embedding_vector IS 'Vector embedding for semantic similarity search';

-- Message buffer for context building (circular, auto-cleaned)
CREATE TABLE IF NOT EXISTS ai_context_messages (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100),
    platform_username VARCHAR(100),
    message_content TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'chatMessage',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_community ON ai_context_messages(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_messages_cleanup ON ai_context_messages(created_at);

COMMENT ON TABLE ai_context_messages IS 'Circular message buffer for building context summaries (auto-cleaned after processing)';
COMMENT ON COLUMN ai_context_messages.message_type IS 'chatMessage, subscription, follow, raid, donation, etc.';

-- AI Insights (summaries and reports)
CREATE TABLE IF NOT EXISTS ai_insights (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    insight_type VARCHAR(50) NOT NULL,                  -- stream_summary/weekly_rollup/bot_detection
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    content_html TEXT,                                  -- Pre-rendered for hub display
    metadata JSONB DEFAULT '{}',                        -- word_cloud, sentiment_data, etc.
    embedding_vector VECTOR(1536),                      -- For RAG recall
    platform VARCHAR(20),                               -- NULL for cross-platform
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    is_premium_only BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_community ON ai_insights(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_insights_type ON ai_insights(community_id, insight_type, created_at DESC);

COMMENT ON TABLE ai_insights IS 'AI-generated insights including stream summaries, weekly rollups, and bot detection reports';
COMMENT ON COLUMN ai_insights.insight_type IS 'Type of insight: stream_summary, weekly_rollup, bot_detection';
COMMENT ON COLUMN ai_insights.metadata IS 'Additional data like word clouds, sentiment graphs, top topics';
COMMENT ON COLUMN ai_insights.embedding_vector IS 'Vector embedding for semantic recall via !or/recall';

-- Bot detection results with enhanced signals
CREATE TABLE IF NOT EXISTS ai_bot_detection_results (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    insight_id INTEGER REFERENCES ai_insights(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    confidence_score DECIMAL(5,2) NOT NULL,             -- 0-100

    -- Enhanced behavioral signals
    behavioral_patterns JSONB DEFAULT '{}',             -- Premium: detailed patterns
    timing_regularity DECIMAL(5,2),                     -- Message timing consistency (higher = bot-like)
    response_latency_avg DECIMAL(8,2),                  -- Avg ms to respond to others
    emote_text_ratio DECIMAL(5,2),                      -- Emote vs text ratio
    copy_paste_frequency INTEGER DEFAULT 0,             -- Same message detected across users
    account_age_days INTEGER,                           -- Platform account age

    recommended_action VARCHAR(50),                     -- none/monitor/warn/timeout/ban
    is_reviewed BOOLEAN DEFAULT FALSE,
    reviewed_by INTEGER REFERENCES hub_users(id),
    reviewed_at TIMESTAMPTZ,
    review_action VARCHAR(50),
    review_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_detection_community ON ai_bot_detection_results(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_detection_confidence ON ai_bot_detection_results(community_id, confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_bot_detection_unreviewed ON ai_bot_detection_results(community_id, is_reviewed) WHERE NOT is_reviewed;

COMMENT ON TABLE ai_bot_detection_results IS 'Bot detection results with enhanced behavioral signals';
COMMENT ON COLUMN ai_bot_detection_results.confidence_score IS 'Bot confidence score from 0 to 100 (higher = more likely bot)';
COMMENT ON COLUMN ai_bot_detection_results.behavioral_patterns IS 'Premium: detailed behavioral analysis JSON';
COMMENT ON COLUMN ai_bot_detection_results.timing_regularity IS 'Standard deviation of message intervals (lower = more regular/bot-like)';
COMMENT ON COLUMN ai_bot_detection_results.recommended_action IS 'AI-recommended moderation action';

-- Research request audit log
CREATE TABLE IF NOT EXISTS ai_research_requests (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    command VARCHAR(20) NOT NULL,                       -- research/ask/recall/summarize
    topic TEXT NOT NULL,
    response TEXT,
    response_destination VARCHAR(20),
    tokens_used INTEGER DEFAULT 0,
    processing_time_ms INTEGER DEFAULT 0,
    was_blocked BOOLEAN DEFAULT FALSE,
    blocked_reason VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_community ON ai_research_requests(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_user ON ai_research_requests(hub_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_rate_limit ON ai_research_requests(community_id, platform_user_id, created_at DESC);

COMMENT ON TABLE ai_research_requests IS 'Audit log of all AI research requests for tracking and rate limiting';
COMMENT ON COLUMN ai_research_requests.command IS 'Command type: research, ask, recall, summarize';
COMMENT ON COLUMN ai_research_requests.was_blocked IS 'Whether request was blocked by safety filters';

-- Rate limiting state (Redis primary, DB fallback)
CREATE TABLE IF NOT EXISTS ai_rate_limit_state (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    platform_user_id VARCHAR(100) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER DEFAULT 1,
    UNIQUE(community_id, platform_user_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_lookup ON ai_rate_limit_state(community_id, platform_user_id, window_start);

COMMENT ON TABLE ai_rate_limit_state IS 'Rate limit tracking (Redis primary, DB fallback for persistence)';
COMMENT ON COLUMN ai_rate_limit_state.window_start IS 'Start of the hourly rate limit window';

-- Global AI researcher settings (superadmin)
INSERT INTO hub_settings (setting_key, setting_value, updated_at) VALUES
    ('ai_researcher_default_provider', 'ollama', NOW()),
    ('ai_researcher_default_model', 'tinyllama', NOW()),
    ('ai_researcher_global_rate_limit', '1000', NOW())
ON CONFLICT (setting_key) DO NOTHING;

COMMENT ON TABLE ai_researcher_config IS 'AI researcher module configuration per community';
COMMENT ON TABLE ai_community_context IS 'Community context snapshots with embeddings for semantic search';
COMMENT ON TABLE ai_context_messages IS 'Message buffer for context building (auto-cleaned)';
COMMENT ON TABLE ai_insights IS 'AI-generated insights: summaries, rollups, bot detection';
COMMENT ON TABLE ai_bot_detection_results IS 'Bot detection results with behavioral signals';
COMMENT ON TABLE ai_research_requests IS 'Audit log of all AI research commands';
COMMENT ON TABLE ai_rate_limit_state IS 'Rate limiting fallback storage';

-- ============================================================================
-- OVERLAY MODULE TABLES
-- ============================================================================

-- Community overlay tokens (one per community)
CREATE TABLE IF NOT EXISTS community_overlay_tokens (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,
    overlay_key CHAR(64) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT TRUE,
    theme_config JSONB DEFAULT '{"background": "transparent"}',
    enabled_sources JSONB DEFAULT '["ticker", "media", "general"]',
    last_accessed TIMESTAMPTZ,
    access_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    rotated_at TIMESTAMPTZ,
    previous_key CHAR(64)  -- Grace period support
);

CREATE INDEX IF NOT EXISTS idx_overlay_tokens_key ON community_overlay_tokens(overlay_key);
CREATE INDEX IF NOT EXISTS idx_overlay_tokens_previous ON community_overlay_tokens(previous_key) WHERE previous_key IS NOT NULL;

-- Access logging for analytics
CREATE TABLE IF NOT EXISTS overlay_access_log (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    overlay_key CHAR(64) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    source_types_requested TEXT[],
    was_valid BOOLEAN DEFAULT TRUE,
    accessed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overlay_access_community ON overlay_access_log(community_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_overlay_access_cleanup ON overlay_access_log(accessed_at);

-- ============================================================================
-- LOYALTY INTERACTION MODULE TABLES
-- ============================================================================

-- Community loyalty configuration
CREATE TABLE IF NOT EXISTS loyalty_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,
    currency_name VARCHAR(50) DEFAULT 'Points',
    currency_symbol VARCHAR(10) DEFAULT '🪙',
    currency_emoji VARCHAR(20) DEFAULT ':coin:',

    -- Feature toggles
    currency_enabled BOOLEAN DEFAULT TRUE,
    giveaways_enabled BOOLEAN DEFAULT TRUE,
    minigames_enabled BOOLEAN DEFAULT TRUE,
    predictions_enabled BOOLEAN DEFAULT TRUE,
    raffles_enabled BOOLEAN DEFAULT TRUE,
    duels_enabled BOOLEAN DEFAULT TRUE,
    gear_enabled BOOLEAN DEFAULT TRUE,

    -- Earning rates (per activity)
    earn_chat_message INTEGER DEFAULT 1,
    earn_chat_cooldown_seconds INTEGER DEFAULT 60,
    earn_watch_time_per_minute INTEGER DEFAULT 2,
    earn_follow INTEGER DEFAULT 50,
    earn_sub_tier1 INTEGER DEFAULT 500,
    earn_sub_tier2 INTEGER DEFAULT 1000,
    earn_sub_tier3 INTEGER DEFAULT 2500,
    earn_gift_sub INTEGER DEFAULT 250,
    earn_raid_per_viewer INTEGER DEFAULT 1,
    earn_cheer_per_100bits INTEGER DEFAULT 10,
    earn_donation_per_dollar INTEGER DEFAULT 10,

    -- Minigame settings
    slots_min_bet INTEGER DEFAULT 10,
    slots_max_bet INTEGER DEFAULT 1000,
    coinflip_min_bet INTEGER DEFAULT 10,
    coinflip_max_bet INTEGER DEFAULT 5000,
    roulette_min_bet INTEGER DEFAULT 10,
    roulette_max_bet INTEGER DEFAULT 1000,

    -- Giveaway settings
    giveaway_reputation_floor INTEGER DEFAULT 450,
    giveaway_weighted_enabled BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_config_community ON loyalty_config(community_id);

-- User currency balances
CREATE TABLE IF NOT EXISTS loyalty_balances (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    balance BIGINT DEFAULT 0 CHECK (balance >= 0),
    lifetime_earned BIGINT DEFAULT 0,
    lifetime_spent BIGINT DEFAULT 0,
    last_chat_earn TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_balances_community ON loyalty_balances(community_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_balances_user ON loyalty_balances(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_balances_balance ON loyalty_balances(community_id, balance DESC);

-- Transaction audit trail
CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL,
    amount BIGINT NOT NULL,
    balance_before BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    description TEXT,
    reference_type VARCHAR(50),
    reference_id INTEGER,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_community ON loyalty_transactions(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user ON loyalty_transactions(hub_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_type ON loyalty_transactions(community_id, transaction_type);

-- Giveaways
CREATE TABLE IF NOT EXISTS loyalty_giveaways (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    prize_description TEXT NOT NULL,
    entry_cost INTEGER DEFAULT 0,
    max_entries_per_user INTEGER DEFAULT 1,
    reputation_floor INTEGER DEFAULT 450,
    weighted_by_reputation BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'draft',
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    winner_user_id INTEGER REFERENCES hub_users(id),
    winner_platform VARCHAR(20),
    winner_platform_user_id VARCHAR(100),
    created_by INTEGER REFERENCES hub_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_giveaways_community ON loyalty_giveaways(community_id, status);
CREATE INDEX IF NOT EXISTS idx_loyalty_giveaways_active ON loyalty_giveaways(community_id, status, ends_at) WHERE status = 'active';

-- Giveaway entries with reputation snapshot
CREATE TABLE IF NOT EXISTS loyalty_giveaway_entries (
    id SERIAL PRIMARY KEY,
    giveaway_id INTEGER REFERENCES loyalty_giveaways(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    entry_count INTEGER DEFAULT 1,
    reputation_score INTEGER,
    reputation_tier VARCHAR(20),
    is_shadow_banned BOOLEAN DEFAULT FALSE,
    weight_multiplier DECIMAL(4,2) DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(giveaway_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_giveaway_entries_giveaway ON loyalty_giveaway_entries(giveaway_id);

-- Minigame results
CREATE TABLE IF NOT EXISTS loyalty_minigame_results (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    game_type VARCHAR(50) NOT NULL,
    bet_amount BIGINT NOT NULL,
    win_amount BIGINT DEFAULT 0,
    result_data JSONB DEFAULT '{}',
    gear_bonus_applied DECIMAL(5,2) DEFAULT 0,
    is_win BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_minigame_results_community ON loyalty_minigame_results(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_minigame_results_user ON loyalty_minigame_results(hub_user_id, created_at DESC);

-- Predictions (betting pools)
CREATE TABLE IF NOT EXISTS loyalty_predictions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    options JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(20) DEFAULT 'draft',
    winning_option INTEGER,
    total_pool BIGINT DEFAULT 0,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_by INTEGER REFERENCES hub_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictions_community ON loyalty_predictions(community_id, status);

-- Prediction bets
CREATE TABLE IF NOT EXISTS loyalty_prediction_bets (
    id SERIAL PRIMARY KEY,
    prediction_id INTEGER REFERENCES loyalty_predictions(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    option_index INTEGER NOT NULL,
    amount BIGINT NOT NULL,
    payout BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(prediction_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_prediction_bets_prediction ON loyalty_prediction_bets(prediction_id);

-- Raffles
CREATE TABLE IF NOT EXISTS loyalty_raffles (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    ticket_cost INTEGER NOT NULL,
    max_tickets_per_user INTEGER DEFAULT 100,
    prize_type VARCHAR(50) DEFAULT 'pot',
    fixed_prize_amount BIGINT,
    status VARCHAR(20) DEFAULT 'draft',
    total_tickets INTEGER DEFAULT 0,
    total_pot BIGINT DEFAULT 0,
    winner_user_id INTEGER REFERENCES hub_users(id),
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    created_by INTEGER REFERENCES hub_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raffles_community ON loyalty_raffles(community_id, status);

-- Raffle tickets
CREATE TABLE IF NOT EXISTS loyalty_raffle_tickets (
    id SERIAL PRIMARY KEY,
    raffle_id INTEGER REFERENCES loyalty_raffles(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    ticket_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(raffle_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_raffle_tickets_raffle ON loyalty_raffle_tickets(raffle_id);

-- Duels
CREATE TABLE IF NOT EXISTS loyalty_duels (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    challenger_user_id INTEGER REFERENCES hub_users(id),
    challenger_platform VARCHAR(20) NOT NULL,
    challenger_platform_user_id VARCHAR(100) NOT NULL,
    defender_user_id INTEGER REFERENCES hub_users(id),
    defender_platform VARCHAR(20),
    defender_platform_user_id VARCHAR(100),
    wager_amount BIGINT NOT NULL,
    duel_type VARCHAR(50) DEFAULT 'standard',
    status VARCHAR(20) DEFAULT 'pending',
    winner_user_id INTEGER REFERENCES hub_users(id),
    challenger_roll INTEGER,
    defender_roll INTEGER,
    challenger_gear_bonus INTEGER DEFAULT 0,
    defender_gear_bonus INTEGER DEFAULT 0,
    is_open_challenge BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_duels_community ON loyalty_duels(community_id, status);
CREATE INDEX IF NOT EXISTS idx_duels_pending ON loyalty_duels(community_id, status, expires_at) WHERE status = 'pending';

-- Duel statistics
CREATE TABLE IF NOT EXISTS loyalty_duel_stats (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    total_duels INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_wagered BIGINT DEFAULT 0,
    total_won BIGINT DEFAULT 0,
    total_lost BIGINT DEFAULT 0,
    win_streak INTEGER DEFAULT 0,
    best_win_streak INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_duel_stats_community ON loyalty_duel_stats(community_id, wins DESC);

-- Gear categories (themed sets)
CREATE TABLE IF NOT EXISTS loyalty_gear_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    emoji VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE
);

INSERT INTO loyalty_gear_categories (name, display_name, description, emoji) VALUES
    ('medieval', 'Medieval', 'Knights, swords, and castles', '⚔️'),
    ('space', 'Space', 'Futuristic space exploration gear', '🚀'),
    ('pirate', 'Pirate', 'Swashbuckling pirate equipment', '🏴‍☠️'),
    ('cyberpunk', 'Cyberpunk', 'High-tech neon future gear', '🤖'),
    ('fantasy', 'Fantasy', 'Magical and mythical items', '🧙')
ON CONFLICT (name) DO NOTHING;

-- Gear items master list
CREATE TABLE IF NOT EXISTS loyalty_gear_items (
    id SERIAL PRIMARY KEY,
    category_id INTEGER REFERENCES loyalty_gear_categories(id),
    name VARCHAR(100) NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    description TEXT,
    item_type VARCHAR(50) NOT NULL,
    rarity VARCHAR(20) DEFAULT 'common',
    attack_bonus INTEGER DEFAULT 0,
    defense_bonus INTEGER DEFAULT 0,
    luck_bonus INTEGER DEFAULT 0,
    cost INTEGER DEFAULT 0,
    is_purchasable BOOLEAN DEFAULT TRUE,
    is_droppable BOOLEAN DEFAULT TRUE,
    drop_weight INTEGER DEFAULT 100,
    emoji VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gear_items_category ON loyalty_gear_items(category_id);
CREATE INDEX IF NOT EXISTS idx_gear_items_type ON loyalty_gear_items(item_type, rarity);

-- User gear inventory
CREATE TABLE IF NOT EXISTS loyalty_user_gear (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    gear_item_id INTEGER REFERENCES loyalty_gear_items(id) ON DELETE CASCADE,
    is_equipped BOOLEAN DEFAULT FALSE,
    acquired_via VARCHAR(50) DEFAULT 'purchase',
    acquired_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, platform, platform_user_id, gear_item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_gear_user ON loyalty_user_gear(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_user_gear_equipped ON loyalty_user_gear(community_id, hub_user_id, is_equipped) WHERE is_equipped = TRUE;

-- Seed default gear items
INSERT INTO loyalty_gear_items (category_id, name, display_name, item_type, rarity, attack_bonus, defense_bonus, luck_bonus, cost, emoji) VALUES
    -- Medieval weapons
    (1, 'rusty_sword', 'Rusty Sword', 'weapon', 'common', 5, 0, 0, 100, '🗡️'),
    (1, 'iron_sword', 'Iron Sword', 'weapon', 'uncommon', 10, 0, 2, 500, '⚔️'),
    (1, 'steel_blade', 'Steel Blade', 'weapon', 'rare', 20, 5, 5, 2000, '🔪'),
    (1, 'legendary_excalibur', 'Excalibur', 'weapon', 'legendary', 50, 20, 15, 25000, '✨'),
    -- Medieval armor
    (1, 'leather_armor', 'Leather Armor', 'armor', 'common', 0, 5, 0, 100, '🥋'),
    (1, 'chainmail', 'Chainmail', 'armor', 'uncommon', 0, 15, 0, 750, '⛓️'),
    (1, 'plate_armor', 'Plate Armor', 'armor', 'rare', 0, 30, 0, 3000, '🛡️'),
    -- Space weapons
    (2, 'laser_pistol', 'Laser Pistol', 'weapon', 'common', 8, 0, 0, 150, '🔫'),
    (2, 'plasma_rifle', 'Plasma Rifle', 'weapon', 'rare', 25, 0, 5, 2500, '💫'),
    (2, 'photon_cannon', 'Photon Cannon', 'weapon', 'epic', 40, 0, 10, 10000, '☄️'),
    -- Pirate gear
    (3, 'cutlass', 'Pirate Cutlass', 'weapon', 'common', 6, 0, 2, 120, '🏴‍☠️'),
    (3, 'flintlock', 'Flintlock Pistol', 'weapon', 'uncommon', 12, 0, 5, 600, '🔫'),
    (3, 'lucky_compass', 'Lucky Compass', 'accessory', 'rare', 0, 0, 20, 1500, '🧭'),
    -- Cyberpunk
    (4, 'neural_blade', 'Neural Blade', 'weapon', 'uncommon', 15, 5, 0, 800, '🔮'),
    (4, 'cyber_arm', 'Cybernetic Arm', 'accessory', 'rare', 20, 10, 5, 4000, '🦾'),
    -- Fantasy
    (5, 'wooden_staff', 'Wooden Staff', 'weapon', 'common', 3, 0, 5, 80, '🪄'),
    (5, 'crystal_wand', 'Crystal Wand', 'weapon', 'rare', 15, 0, 15, 2200, '💎'),
    (5, 'dragon_scale', 'Dragon Scale Shield', 'armor', 'epic', 10, 40, 10, 12000, '🐉')
ON CONFLICT DO NOTHING;

-- ============================================================
-- CALENDAR & EVENTS MODULE TABLES
-- ============================================================
-- Complete event management system with RSVP, recurring events,
-- platform sync (Discord, Twitch, YouTube), and multi-community context

-- Multi-community context tracking (entities can belong to multiple communities)
CREATE TABLE IF NOT EXISTS entity_community_context (
    id SERIAL PRIMARY KEY,
    entity_id VARCHAR(255) NOT NULL,  -- discord:guild_id or slack:workspace_id
    platform VARCHAR(50) NOT NULL,
    default_community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    available_communities JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Array of community IDs
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_entity_context_entity ON entity_community_context(entity_id, platform);
CREATE INDEX IF NOT EXISTS idx_entity_context_community ON entity_community_context(default_community_id);

-- Core events table with all event details, recurring patterns, platform sync IDs
CREATE TABLE IF NOT EXISTS calendar_events (
    id SERIAL PRIMARY KEY,
    event_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    entity_id VARCHAR(255) NOT NULL,  -- discord:guild_id, slack:workspace_id, etc.
    platform VARCHAR(50) NOT NULL,  -- discord, slack, twitch, youtube

    -- Event details
    title VARCHAR(255) NOT NULL,
    description TEXT,
    event_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ,
    timezone VARCHAR(50) DEFAULT 'UTC',
    location VARCHAR(255),  -- Physical or virtual location
    cover_image_url TEXT,

    -- RSVP settings
    max_attendees INTEGER,  -- NULL = unlimited
    rsvp_enabled BOOLEAN DEFAULT TRUE,
    rsvp_deadline TIMESTAMPTZ,
    waitlist_enabled BOOLEAN DEFAULT TRUE,

    -- Recurring event settings
    is_recurring BOOLEAN DEFAULT FALSE,
    recurring_pattern VARCHAR(20),  -- 'daily', 'weekly', 'monthly'
    recurring_days JSONB,  -- For weekly: [0,1,2,3,4,5,6] (Sun-Sat), monthly: [1,15,30]
    recurring_end_date TIMESTAMPTZ,
    parent_event_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,  -- NULL for parent, set for instances

    -- Approval workflow
    status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'cancelled'
    approved_by INTEGER REFERENCES hub_users(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,

    -- Event creator
    created_by_user_id INTEGER REFERENCES hub_users(id),
    created_by_platform_user_id VARCHAR(100),
    created_by_username VARCHAR(100),

    -- Platform sync IDs
    discord_event_id VARCHAR(100),
    twitch_segment_id VARCHAR(100),
    youtube_broadcast_id VARCHAR(100),
    sync_status VARCHAR(20) DEFAULT 'not_synced',  -- 'not_synced', 'synced', 'sync_failed', 'conflict'
    last_sync_at TIMESTAMPTZ,
    sync_error TEXT,

    -- Categorization
    category_id INTEGER REFERENCES calendar_categories(id),
    tags JSONB DEFAULT '[]'::jsonb,  -- Array of tags

    -- Engagement metrics
    view_count INTEGER DEFAULT 0,
    attending_count INTEGER DEFAULT 0,
    interested_count INTEGER DEFAULT 0,
    declined_count INTEGER DEFAULT 0,

    -- Event series (for themed recurring events by same host)
    series_id INTEGER REFERENCES calendar_event_series(id),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_event_dates CHECK (end_date IS NULL OR end_date > event_date),
    CONSTRAINT valid_recurring CHECK (
        (is_recurring = FALSE) OR
        (is_recurring = TRUE AND recurring_pattern IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_community ON calendar_events(community_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_entity ON calendar_events(entity_id, platform);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(event_date) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(status);
CREATE INDEX IF NOT EXISTS idx_calendar_events_recurring ON calendar_events(is_recurring, parent_event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_sync ON calendar_events(discord_event_id, twitch_segment_id, youtube_broadcast_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events(series_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_creator ON calendar_events(created_by_user_id);

-- Full-text search on title and description
CREATE INDEX IF NOT EXISTS idx_calendar_events_search ON calendar_events USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')));

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_events_updated_at BEFORE UPDATE ON calendar_events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- User RSVPs with status, waitlist, guest count
CREATE TABLE IF NOT EXISTS calendar_rsvps (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,

    -- User identification
    hub_user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    username VARCHAR(100) NOT NULL,

    -- RSVP details
    rsvp_status VARCHAR(20) NOT NULL,  -- 'yes', 'no', 'maybe'
    guest_count INTEGER DEFAULT 0,  -- Additional guests (+1, +2, etc.)
    is_waitlisted BOOLEAN DEFAULT FALSE,
    waitlist_position INTEGER,

    -- Reminder tracking
    reminder_15min_sent BOOLEAN DEFAULT FALSE,
    reminder_1hour_sent BOOLEAN DEFAULT FALSE,
    reminder_24hour_sent BOOLEAN DEFAULT FALSE,
    reminder_1week_sent BOOLEAN DEFAULT FALSE,

    -- Notes from user
    user_note TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(event_id, platform, platform_user_id),
    CONSTRAINT valid_rsvp_status CHECK (rsvp_status IN ('yes', 'no', 'maybe')),
    CONSTRAINT valid_guest_count CHECK (guest_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_calendar_rsvps_event ON calendar_rsvps(event_id, rsvp_status);
CREATE INDEX IF NOT EXISTS idx_calendar_rsvps_user ON calendar_rsvps(hub_user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_rsvps_waitlist ON calendar_rsvps(event_id, is_waitlisted, waitlist_position) WHERE is_waitlisted = TRUE;
CREATE INDEX IF NOT EXISTS idx_calendar_rsvps_reminders ON calendar_rsvps(event_id) WHERE rsvp_status = 'yes' AND (
    reminder_15min_sent = FALSE OR
    reminder_1hour_sent = FALSE OR
    reminder_24hour_sent = FALSE OR
    reminder_1week_sent = FALSE
);

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_rsvps_updated_at BEFORE UPDATE ON calendar_rsvps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Event categories
CREATE TABLE IF NOT EXISTS calendar_categories (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    color VARCHAR(7),  -- Hex color code #RRGGBB
    icon VARCHAR(100),  -- Emoji or icon name
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, name)
);

CREATE INDEX IF NOT EXISTS idx_calendar_categories_community ON calendar_categories(community_id, display_order);

-- Insert default categories
INSERT INTO calendar_categories (community_id, name, description, color, icon, display_order)
SELECT
    c.id,
    cat.name,
    cat.description,
    cat.color,
    cat.icon,
    cat.display_order
FROM communities c
CROSS JOIN (VALUES
    ('Gaming', 'Gaming sessions and tournaments', '#9B59B6', '🎮', 1),
    ('Social', 'Hangouts and community gatherings', '#3498DB', '👥', 2),
    ('Educational', 'Workshops and learning sessions', '#2ECC71', '📚', 3),
    ('Tournament', 'Competitive gaming events', '#E74C3C', '🏆', 4),
    ('Watch Party', 'Group viewing events', '#F39C12', '📺', 5),
    ('Community Meeting', 'Planning and discussion meetings', '#1ABC9C', '💬', 6),
    ('Special Event', 'Unique one-time events', '#E67E22', '⭐', 7)
) AS cat(name, description, color, icon, display_order)
WHERE c.is_active = TRUE
ON CONFLICT (community_id, name) DO NOTHING;

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_categories_updated_at BEFORE UPDATE ON calendar_categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Community-specific reminder configuration
CREATE TABLE IF NOT EXISTS calendar_reminder_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,

    -- Allowed reminder times
    allow_15min BOOLEAN DEFAULT TRUE,
    allow_1hour BOOLEAN DEFAULT TRUE,
    allow_24hour BOOLEAN DEFAULT TRUE,
    allow_1week BOOLEAN DEFAULT TRUE,

    -- Default reminder times (auto-enabled for new events)
    default_15min BOOLEAN DEFAULT FALSE,
    default_1hour BOOLEAN DEFAULT TRUE,
    default_24hour BOOLEAN DEFAULT TRUE,
    default_1week BOOLEAN DEFAULT FALSE,

    -- Notification channels
    notify_chat BOOLEAN DEFAULT TRUE,  -- Send to platform chat
    notify_dm BOOLEAN DEFAULT FALSE,  -- Send DM to attendees
    notify_email BOOLEAN DEFAULT FALSE,  -- Send email (if available)

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_reminder_config_community ON calendar_reminder_config(community_id);

-- Insert default reminder config for all communities
INSERT INTO calendar_reminder_config (community_id)
SELECT id FROM communities WHERE is_active = TRUE
ON CONFLICT (community_id) DO NOTHING;

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_reminder_config_updated_at BEFORE UPDATE ON calendar_reminder_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RBAC permissions configuration per community
CREATE TABLE IF NOT EXISTS calendar_permissions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,

    -- Who can create events
    create_permission VARCHAR(20) DEFAULT 'admin_mod',  -- 'admin_only', 'admin_mod', 'admin_mod_vip', 'all_members'

    -- Edit permissions
    edit_own_events BOOLEAN DEFAULT TRUE,  -- Can edit their own events
    edit_all_events VARCHAR(20) DEFAULT 'admin_only',  -- 'admin_only', 'admin_mod', 'none'

    -- Delete permissions
    delete_own_events BOOLEAN DEFAULT TRUE,  -- Can delete their own events
    delete_all_events VARCHAR(20) DEFAULT 'admin_only',  -- 'admin_only', 'admin_mod', 'none'

    -- Approval workflow
    require_approval BOOLEAN DEFAULT TRUE,
    auto_approve_admins BOOLEAN DEFAULT TRUE,
    auto_approve_mods BOOLEAN DEFAULT FALSE,  -- Mods ALSO need approval by default
    auto_approve_vips BOOLEAN DEFAULT FALSE,
    auto_approve_all BOOLEAN DEFAULT FALSE,

    -- Custom approval rules (JSONB for flexibility)
    approval_rules JSONB DEFAULT '{}'::jsonb,

    -- Who can RSVP
    rsvp_permission VARCHAR(20) DEFAULT 'all_members',  -- 'admin_mod', 'all_members', 'subscribers_only'

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_create_permission CHECK (create_permission IN ('admin_only', 'admin_mod', 'admin_mod_vip', 'all_members')),
    CONSTRAINT valid_edit_all CHECK (edit_all_events IN ('admin_only', 'admin_mod', 'none')),
    CONSTRAINT valid_delete_all CHECK (delete_all_events IN ('admin_only', 'admin_mod', 'none')),
    CONSTRAINT valid_rsvp_permission CHECK (rsvp_permission IN ('admin_mod', 'all_members', 'subscribers_only'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_permissions_community ON calendar_permissions(community_id);

-- Insert default permissions for all communities
INSERT INTO calendar_permissions (community_id)
SELECT id FROM communities WHERE is_active = TRUE
ON CONFLICT (community_id) DO NOTHING;

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_permissions_updated_at BEFORE UPDATE ON calendar_permissions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Platform sync configuration and status
CREATE TABLE IF NOT EXISTS calendar_sync_state (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    entity_id VARCHAR(255) NOT NULL,  -- discord:guild_id, slack:workspace_id, etc.
    platform VARCHAR(50) NOT NULL,  -- 'discord', 'twitch', 'youtube'

    -- Sync configuration
    sync_enabled BOOLEAN DEFAULT FALSE,
    sync_direction VARCHAR(20) DEFAULT 'both',  -- 'push_only', 'import_new_only', 'both'
    auto_sync_new_events BOOLEAN DEFAULT TRUE,
    auto_sync_updates BOOLEAN DEFAULT TRUE,
    sync_rsvps BOOLEAN DEFAULT TRUE,  -- Sync RSVP data from platform

    -- Platform credentials/tokens (encrypted in production)
    platform_credentials JSONB DEFAULT '{}'::jsonb,

    -- Sync status
    last_sync_at TIMESTAMPTZ,
    last_sync_status VARCHAR(20),  -- 'success', 'failed', 'partial'
    last_sync_error TEXT,
    events_synced_count INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(community_id, entity_id, platform),
    CONSTRAINT valid_sync_direction CHECK (sync_direction IN ('push_only', 'import_new_only', 'both'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_state_community ON calendar_sync_state(community_id, platform);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_state_entity ON calendar_sync_state(entity_id, platform);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_state_enabled ON calendar_sync_state(sync_enabled) WHERE sync_enabled = TRUE;

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_sync_state_updated_at BEFORE UPDATE ON calendar_sync_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Activity audit log for all event actions (AAA logging)
CREATE TABLE IF NOT EXISTS calendar_activity_log (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,

    -- Activity details
    activity_type VARCHAR(50) NOT NULL,  -- 'created', 'updated', 'deleted', 'approved', 'rejected', 'rsvp', 'cancelled', 'synced'

    -- User who performed action
    user_id INTEGER REFERENCES hub_users(id),
    username VARCHAR(100),
    platform VARCHAR(50),
    platform_user_id VARCHAR(100),

    -- Action details
    details JSONB DEFAULT '{}'::jsonb,  -- Flexible details storage
    changes JSONB DEFAULT '{}'::jsonb,  -- Before/after values for updates

    -- IP and user agent (for security audit)
    ip_address INET,
    user_agent TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_activity_log_event ON calendar_activity_log(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_activity_log_community ON calendar_activity_log(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_activity_log_user ON calendar_activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_activity_log_type ON calendar_activity_log(activity_type, created_at DESC);

-- Event series (for recurring themed events by same host)
CREATE TABLE IF NOT EXISTS calendar_event_series (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    series_name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Host information
    host_user_id INTEGER REFERENCES hub_users(id),
    host_platform_user_id VARCHAR(100),
    host_username VARCHAR(100),

    -- Series metadata
    category_id INTEGER REFERENCES calendar_categories(id),
    tags JSONB DEFAULT '[]'::jsonb,
    cover_image_url TEXT,

    -- Stats
    total_events INTEGER DEFAULT 0,
    total_attendees INTEGER DEFAULT 0,
    average_rating DECIMAL(3,2),

    -- Series status
    is_active BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(community_id, series_name)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_series_community ON calendar_event_series(community_id, is_active);
CREATE INDEX IF NOT EXISTS idx_calendar_event_series_host ON calendar_event_series(host_user_id);

-- Trigger to update updated_at
CREATE TRIGGER update_calendar_event_series_updated_at BEFORE UPDATE ON calendar_event_series
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- KONG API GATEWAY DATABASE SETUP
-- ============================================================
-- Create separate database for Kong Gateway
-- This keeps Kong configuration isolated from WaddleBot data

-- Create Kong database owned by waddlebot (for admin access)
CREATE DATABASE kong OWNER waddlebot;

-- Create Kong user with limited permissions
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'kong') THEN
        CREATE ROLE kong WITH LOGIN PASSWORD 'kong_db_pass_change_me';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE kong TO kong;

-- Switch to kong database
\c kong

-- Grant Kong user full access to public schema only
GRANT ALL PRIVILEGES ON SCHEMA public TO kong;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO kong;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO kong;

-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO kong;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO kong;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO kong;

-- Switch back to waddlebot database (default)
\c waddlebot

-- ============================================================================
-- ANALYTICS CORE MODULE TABLES
-- ============================================================================

-- Analytics configuration per community
CREATE TABLE IF NOT EXISTS analytics_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,
    is_premium BOOLEAN DEFAULT FALSE,

    -- Feature toggles
    basic_stats_enabled BOOLEAN DEFAULT TRUE,
    community_health_enabled BOOLEAN DEFAULT FALSE,  -- Premium
    bad_actor_detection_enabled BOOLEAN DEFAULT FALSE,  -- Premium
    user_journey_enabled BOOLEAN DEFAULT FALSE,  -- Premium

    -- Data retention (days)
    raw_data_retention_days INTEGER DEFAULT 30,
    aggregated_data_retention_days INTEGER DEFAULT 365,

    -- Polling interval for real-time updates (seconds)
    polling_interval_seconds INTEGER DEFAULT 30,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_config_community ON analytics_config(community_id);

COMMENT ON TABLE analytics_config IS 'Per-community analytics configuration';
COMMENT ON COLUMN analytics_config.is_premium IS 'Premium tier enables advanced analytics features';

-- Time-series metrics storage (configurable periods)
CREATE TABLE IF NOT EXISTS analytics_metrics_timeseries (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    metric_type VARCHAR(50) NOT NULL,  -- 'messages', 'viewers', 'engagement', 'growth'
    metric_subtype VARCHAR(50),  -- Platform or subcategory
    timestamp_bucket TIMESTAMPTZ NOT NULL,  -- Rounded to interval
    bucket_size VARCHAR(20) NOT NULL,  -- '1h', '1d', '1w', '1m'
    value NUMERIC(15,4) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, metric_type, metric_subtype, timestamp_bucket, bucket_size)
);

CREATE INDEX IF NOT EXISTS idx_analytics_timeseries_lookup ON analytics_metrics_timeseries(community_id, metric_type, timestamp_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_timeseries_bucket ON analytics_metrics_timeseries(community_id, bucket_size, timestamp_bucket DESC);

COMMENT ON TABLE analytics_metrics_timeseries IS 'Time-series metrics with configurable bucket sizes';

-- Activity heatmaps (hourly activity by day of week)
CREATE TABLE IF NOT EXISTS analytics_activity_heatmaps (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),  -- 0=Sunday
    hour_of_day INTEGER NOT NULL CHECK (hour_of_day >= 0 AND hour_of_day <= 23),
    metric_type VARCHAR(50) NOT NULL,  -- 'messages', 'viewers', 'engagement'
    avg_value NUMERIC(15,4) DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, day_of_week, hour_of_day, metric_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_analytics_heatmaps_community ON analytics_activity_heatmaps(community_id, metric_type);

COMMENT ON TABLE analytics_activity_heatmaps IS 'Activity heatmaps showing hourly patterns by day of week';

-- Community health snapshots (Premium)
CREATE TABLE IF NOT EXISTS analytics_community_health (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,

    -- Member metrics
    total_members INTEGER DEFAULT 0,
    active_members_7d INTEGER DEFAULT 0,
    active_members_30d INTEGER DEFAULT 0,
    new_members_7d INTEGER DEFAULT 0,
    churned_members_7d INTEGER DEFAULT 0,

    -- Engagement metrics
    engagement_score DECIMAL(5,2),  -- 0-100
    avg_messages_per_active_user DECIMAL(10,2),
    avg_watch_time_per_active_user INTEGER,  -- seconds

    -- Growth metrics
    member_growth_rate DECIMAL(8,4),  -- Percentage
    engagement_trend DECIMAL(8,4),  -- Percentage change

    -- Health indicators
    health_grade VARCHAR(2),  -- A+, A, B+, B, C+, C, D, F
    health_factors JSONB DEFAULT '{}',  -- Breakdown of factors

    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_analytics_health_community ON analytics_community_health(community_id, snapshot_date DESC);

COMMENT ON TABLE analytics_community_health IS 'Premium: Daily community health snapshots with scoring';

-- User journey/retention cohorts (Premium)
CREATE TABLE IF NOT EXISTS analytics_retention_cohorts (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    cohort_date DATE NOT NULL,  -- Week/month user joined
    cohort_type VARCHAR(20) NOT NULL,  -- 'weekly', 'monthly'
    days_since_join INTEGER NOT NULL,
    retained_count INTEGER DEFAULT 0,
    original_count INTEGER DEFAULT 0,
    retention_rate DECIMAL(5,4),  -- 0-1
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, cohort_date, cohort_type, days_since_join)
);

CREATE INDEX IF NOT EXISTS idx_analytics_cohorts_community ON analytics_retention_cohorts(community_id, cohort_type, cohort_date DESC);

COMMENT ON TABLE analytics_retention_cohorts IS 'Premium: Retention cohort analysis by join date';

-- Engagement funnels (Premium)
CREATE TABLE IF NOT EXISTS analytics_engagement_funnels (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    funnel_name VARCHAR(100) NOT NULL,  -- 'new_user_activation', 'subscriber_journey'
    step_number INTEGER NOT NULL,
    step_name VARCHAR(100) NOT NULL,
    step_description TEXT,
    users_at_step INTEGER DEFAULT 0,
    conversion_rate DECIMAL(5,4),  -- From previous step
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, funnel_name, step_number, period_start)
);

CREATE INDEX IF NOT EXISTS idx_analytics_funnels_community ON analytics_engagement_funnels(community_id, funnel_name);

COMMENT ON TABLE analytics_engagement_funnels IS 'Premium: Engagement funnel tracking';

-- Bad actor detection results (Premium)
CREATE TABLE IF NOT EXISTS analytics_bad_actor_alerts (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    alert_type VARCHAR(50) NOT NULL,  -- 'spam_pattern', 'suspicious_behavior', 'coordinated_attack'
    severity VARCHAR(20) NOT NULL,  -- 'low', 'medium', 'high', 'critical'

    -- User information
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),
    hub_user_id INTEGER REFERENCES hub_users(id),

    -- Alert details
    confidence_score DECIMAL(5,2) NOT NULL,  -- 0-100
    detection_signals JSONB NOT NULL,  -- Detailed signals
    sample_evidence JSONB,  -- Sample messages/actions

    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'reviewed', 'actioned', 'dismissed'
    reviewed_by INTEGER REFERENCES hub_users(id),
    reviewed_at TIMESTAMPTZ,
    action_taken VARCHAR(50),
    review_notes TEXT,

    detected_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_bad_actor_community ON analytics_bad_actor_alerts(community_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_bad_actor_user ON analytics_bad_actor_alerts(platform, platform_user_id);

COMMENT ON TABLE analytics_bad_actor_alerts IS 'Premium: Bad actor detection alerts with behavioral analysis';

-- ============================================================================
-- SECURITY CORE MODULE TABLES
-- ============================================================================

-- Security configuration per community
CREATE TABLE IF NOT EXISTS security_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE UNIQUE,

    -- Spam detection settings
    spam_detection_enabled BOOLEAN DEFAULT TRUE,
    spam_message_threshold INTEGER DEFAULT 5,  -- Messages per interval
    spam_interval_seconds INTEGER DEFAULT 10,
    spam_duplicate_threshold INTEGER DEFAULT 3,  -- Duplicate messages
    spam_action VARCHAR(20) DEFAULT 'warn',  -- 'warn', 'timeout', 'mute', 'ban'

    -- Rate limiting
    rate_limit_enabled BOOLEAN DEFAULT TRUE,
    rate_limit_messages_per_minute INTEGER DEFAULT 30,
    rate_limit_commands_per_minute INTEGER DEFAULT 10,

    -- Content filtering
    content_filter_enabled BOOLEAN DEFAULT TRUE,
    blocked_words TEXT[] DEFAULT '{}',
    blocked_patterns TEXT[] DEFAULT '{}',  -- Regex patterns
    filter_action VARCHAR(20) DEFAULT 'delete',  -- 'delete', 'warn', 'timeout'

    -- Warning system
    warning_enabled BOOLEAN DEFAULT TRUE,
    warning_threshold_timeout INTEGER DEFAULT 3,  -- Warnings before timeout
    warning_threshold_ban INTEGER DEFAULT 5,
    warning_decay_days INTEGER DEFAULT 30,  -- Days before warning expires

    -- Auto-timeout settings
    auto_timeout_first_minutes INTEGER DEFAULT 5,
    auto_timeout_second_minutes INTEGER DEFAULT 60,
    auto_timeout_third_minutes INTEGER DEFAULT 1440,  -- 24 hours

    -- Integration with reputation
    reputation_impact_enabled BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_config_community ON security_config(community_id);

COMMENT ON TABLE security_config IS 'Per-community security and moderation configuration';

-- User warnings
CREATE TABLE IF NOT EXISTS security_warnings (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id),
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),

    warning_type VARCHAR(50) NOT NULL,  -- 'spam', 'content_filter', 'manual', 'rate_limit'
    warning_reason TEXT,
    auto_generated BOOLEAN DEFAULT TRUE,
    issued_by INTEGER REFERENCES hub_users(id),  -- NULL if auto

    -- Context
    trigger_message TEXT,
    trigger_metadata JSONB DEFAULT '{}',

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by INTEGER REFERENCES hub_users(id),
    revoke_reason TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_warnings_community ON security_warnings(community_id, is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_warnings_user ON security_warnings(platform, platform_user_id, is_active);

COMMENT ON TABLE security_warnings IS 'User warning tracking with expiration';

-- User rate limit state (Redis primary, DB fallback)
CREATE TABLE IF NOT EXISTS security_rate_limit_state (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    rate_type VARCHAR(20) NOT NULL,  -- 'message', 'command'
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER DEFAULT 1,
    UNIQUE(community_id, platform, platform_user_id, rate_type, window_start)
);

CREATE INDEX IF NOT EXISTS idx_security_rate_limit_lookup ON security_rate_limit_state(community_id, platform, platform_user_id, rate_type);

COMMENT ON TABLE security_rate_limit_state IS 'Rate limit tracking (Redis primary, DB fallback)';

-- Content filter matches (audit log)
CREATE TABLE IF NOT EXISTS security_filter_matches (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),

    filter_type VARCHAR(30) NOT NULL,  -- 'blocked_word', 'regex_pattern', 'spam_duplicate'
    matched_pattern TEXT,
    original_message TEXT,
    action_taken VARCHAR(20) NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_filter_matches_community ON security_filter_matches(community_id, created_at DESC);

COMMENT ON TABLE security_filter_matches IS 'Audit log of content filter matches';

-- Cross-platform moderation coordination
CREATE TABLE IF NOT EXISTS security_moderation_actions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,

    -- Target user
    hub_user_id INTEGER REFERENCES hub_users(id),
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100),

    -- Action details
    action_type VARCHAR(30) NOT NULL,  -- 'warn', 'timeout', 'kick', 'ban', 'unban'
    action_reason TEXT,
    duration_seconds INTEGER,  -- For timeouts

    -- Source
    source_platform VARCHAR(20),  -- Platform where action originated
    moderator_id INTEGER REFERENCES hub_users(id),
    auto_generated BOOLEAN DEFAULT FALSE,

    -- Cross-platform sync
    sync_to_platforms TEXT[] DEFAULT '{}',  -- Platforms to sync action to
    sync_status JSONB DEFAULT '{}',  -- Per-platform sync status

    -- Reputation impact
    reputation_change DECIMAL(6,2),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_mod_actions_community ON security_moderation_actions(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_mod_actions_user ON security_moderation_actions(platform, platform_user_id);

COMMENT ON TABLE security_moderation_actions IS 'Cross-platform moderation action coordination';

-- ============================================================================
-- AI RESEARCHER ENHANCEMENT TABLES
-- ============================================================================

-- Enhanced community insights (for AI-generated community health reports)
CREATE TABLE IF NOT EXISTS ai_community_insights (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    insight_period VARCHAR(20) NOT NULL,  -- 'weekly', 'monthly'
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,

    -- Trending topics
    trending_topics JSONB DEFAULT '[]',  -- [{topic, mentions, sentiment, trend}]

    -- Sentiment analysis
    overall_sentiment DECIMAL(4,3),  -- -1 to 1
    sentiment_breakdown JSONB DEFAULT '{}',  -- {positive, negative, neutral percentages}
    sentiment_trend DECIMAL(4,3),  -- Change from previous period

    -- Community behavior
    peak_activity_hours JSONB DEFAULT '[]',
    most_active_users JSONB DEFAULT '[]',
    emerging_topics JSONB DEFAULT '[]',

    -- AI-generated narrative
    summary_text TEXT,
    summary_html TEXT,
    key_highlights JSONB DEFAULT '[]',
    recommendations JSONB DEFAULT '[]',

    -- Anomalies detected
    anomalies JSONB DEFAULT '[]',  -- Unusual patterns

    -- Generation metadata
    ai_model VARCHAR(100),
    tokens_used INTEGER DEFAULT 0,
    generation_time_ms INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, insight_period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_community_insights ON ai_community_insights(community_id, insight_period, period_start DESC);

COMMENT ON TABLE ai_community_insights IS 'AI-generated community insights and health reports';

-- User behavior profiles (for anomaly detection)
CREATE TABLE IF NOT EXISTS ai_user_behavior_profiles (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    hub_user_id INTEGER REFERENCES hub_users(id),
    platform VARCHAR(20) NOT NULL,
    platform_user_id VARCHAR(100) NOT NULL,

    -- Activity patterns
    avg_messages_per_day DECIMAL(10,2),
    avg_watch_time_per_session INTEGER,  -- seconds
    typical_active_hours JSONB DEFAULT '[]',
    typical_active_days JSONB DEFAULT '[]',

    -- Content patterns
    avg_message_length DECIMAL(10,2),
    emote_usage_rate DECIMAL(5,4),
    command_usage_rate DECIMAL(5,4),
    topic_interests JSONB DEFAULT '[]',

    -- Social patterns
    interaction_style VARCHAR(50),  -- 'lurker', 'casual', 'active', 'leader'
    response_rate DECIMAL(5,4),
    avg_response_time_seconds INTEGER,

    -- Baseline for anomaly detection
    baseline_computed_at TIMESTAMPTZ,
    baseline_data JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_user_profiles_community ON ai_user_behavior_profiles(community_id);

COMMENT ON TABLE ai_user_behavior_profiles IS 'User behavior profiles for anomaly detection';

-- Anomaly detection results
CREATE TABLE IF NOT EXISTS ai_anomaly_detections (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,

    anomaly_type VARCHAR(50) NOT NULL,  -- 'activity_spike', 'sentiment_shift', 'unusual_user', 'topic_surge'
    severity VARCHAR(20) NOT NULL,  -- 'info', 'warning', 'alert', 'critical'

    -- Anomaly details
    description TEXT NOT NULL,
    affected_metrics JSONB DEFAULT '[]',
    baseline_values JSONB DEFAULT '{}',
    observed_values JSONB DEFAULT '{}',
    deviation_score DECIMAL(8,4),

    -- Related entities
    related_users JSONB DEFAULT '[]',
    related_topics JSONB DEFAULT '[]',

    -- Status
    status VARCHAR(20) DEFAULT 'new',  -- 'new', 'acknowledged', 'resolved', 'false_positive'
    acknowledged_by INTEGER REFERENCES hub_users(id),
    acknowledged_at TIMESTAMPTZ,
    resolution_notes TEXT,

    detected_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_anomalies_community ON ai_anomaly_detections(community_id, status, detected_at DESC);

COMMENT ON TABLE ai_anomaly_detections IS 'Anomaly detection results with severity tracking';

-- Development notice
DO $$
BEGIN
    RAISE NOTICE 'WaddleBot development database initialized successfully';
    RAISE NOTICE 'Database: waddlebot';
    RAISE NOTICE 'Main user: waddlebot / waddlebot123';
    RAISE NOTICE 'Kong database: kong (user: kong / kong_db_pass_change_me)';
    RAISE NOTICE 'Dev user: waddlebot_dev / dev123';
    RAISE NOTICE 'Global community created: waddlebot-global';
    RAISE NOTICE 'AI Researcher module tables created with pgvector support';
    RAISE NOTICE 'Overlay module tables created';
    RAISE NOTICE 'Loyalty module tables created with gear system and minigames';
    RAISE NOTICE 'Calendar module tables created with RSVP, recurring events, and platform sync';
    RAISE NOTICE 'Analytics module tables created (basic + premium features)';
    RAISE NOTICE 'Security module tables created (spam, warnings, moderation)';
    RAISE NOTICE 'AI enhancement tables created (insights, anomalies, behavior profiles)';
END
$$;
-- ============================================================================
-- Additional Tables for Hub Features (from migration 004)
-- ============================================================================

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

