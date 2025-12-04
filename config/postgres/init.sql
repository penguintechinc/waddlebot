-- WaddleBot Development Database Initialization
-- This script sets up the basic database structure for development

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
    platform VARCHAR(50) NOT NULL,
    platform_server_id VARCHAR(255),
    owner_id INTEGER REFERENCES hub_users(id),
    owner_name VARCHAR(255),
    member_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_public BOOLEAN DEFAULT TRUE,
    is_global BOOLEAN DEFAULT FALSE,
    join_mode VARCHAR(20) DEFAULT 'open',
    config JSONB DEFAULT '{}',
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    deleted_by VARCHAR(255)
);
COMMENT ON COLUMN communities.join_mode IS 'open = anyone can join, approval = requires admin/mod approval, invite = invite only';
COMMENT ON COLUMN communities.is_global IS 'Global community that all users are auto-added to. Cannot be deleted.';

CREATE INDEX IF NOT EXISTS idx_communities_name ON communities(name);
CREATE INDEX IF NOT EXISTS idx_communities_platform ON communities(platform, platform_server_id);
CREATE INDEX IF NOT EXISTS idx_communities_active ON communities(is_active, is_public);

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

-- Development notice
DO $$
BEGIN
    RAISE NOTICE 'WaddleBot development database initialized successfully';
    RAISE NOTICE 'Database: waddlebot';
    RAISE NOTICE 'Main user: waddlebot / waddlebot123';
    RAISE NOTICE 'Dev user: waddlebot_dev / dev123';
    RAISE NOTICE 'Global community created: waddlebot-global';
END
$$;