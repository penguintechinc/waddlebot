-- Migration 009: Add shoutout configuration tables
-- Supports both !so (text) and !vso (video) shoutout commands with permissions
-- NOTE: Shoutouts only available for 'creator' and 'gaming' community types

-- Shoutout permissions and configuration (per community)
CREATE TABLE IF NOT EXISTS shoutout_config (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    -- Text shoutout (!so / /so) permissions
    so_enabled BOOLEAN DEFAULT true,
    so_permission VARCHAR(20) DEFAULT 'mod', -- 'admin_only', 'mod', 'vip', 'subscriber', 'everyone'
    -- Video shoutout (!vso / /vso) permissions
    vso_enabled BOOLEAN DEFAULT true,
    vso_permission VARCHAR(20) DEFAULT 'mod', -- 'admin_only', 'mod', 'vip', 'subscriber', 'everyone'
    -- Auto-shoutout settings (applies to video shoutouts)
    auto_shoutout_mode VARCHAR(20) DEFAULT 'disabled', -- 'disabled', 'all_creators', 'list_only', 'role_based'
    trigger_first_message BOOLEAN DEFAULT false,
    trigger_raid_host BOOLEAN DEFAULT true,
    -- Video widget settings
    widget_position VARCHAR(20) DEFAULT 'bottom-right', -- 'top-left', 'top-right', 'bottom-left', 'bottom-right'
    widget_duration_seconds INTEGER DEFAULT 30,
    cooldown_minutes INTEGER DEFAULT 60,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id)
);

CREATE INDEX IF NOT EXISTS idx_shoutout_config_community ON shoutout_config(community_id);

COMMENT ON TABLE shoutout_config IS 'Per-community configuration for !so and !vso shoutout commands';
COMMENT ON COLUMN shoutout_config.so_permission IS 'Who can use !so: admin_only, mod, vip, subscriber, everyone';
COMMENT ON COLUMN shoutout_config.vso_permission IS 'Who can use !vso: admin_only, mod, vip, subscriber, everyone';
COMMENT ON COLUMN shoutout_config.auto_shoutout_mode IS 'Auto-shoutout mode: disabled, all_creators, list_only, role_based';

-- Custom role permissions for shoutout commands (fine-grained control)
CREATE TABLE IF NOT EXISTS shoutout_command_permissions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    role_name VARCHAR(50) NOT NULL, -- 'admin', 'moderator', 'vip', 'subscriber', custom roles
    can_use_so BOOLEAN DEFAULT true,
    can_use_vso BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_shoutout_permissions_community ON shoutout_command_permissions(community_id);

COMMENT ON TABLE shoutout_command_permissions IS 'Fine-grained role permissions for shoutout commands';

-- Manual creator list for auto-shoutouts
CREATE TABLE IF NOT EXISTS auto_shoutout_creators (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL, -- 'twitch', 'youtube', 'discord', etc.
    platform_user_id VARCHAR(100) NOT NULL,
    platform_username VARCHAR(100) NOT NULL,
    custom_trigger VARCHAR(20) DEFAULT 'default', -- 'default', 'first_message', 'raid_only', 'manual_only'
    added_by INTEGER REFERENCES hub_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_auto_shoutout_creators_community ON auto_shoutout_creators(community_id);
CREATE INDEX IF NOT EXISTS idx_auto_shoutout_creators_platform ON auto_shoutout_creators(platform, platform_user_id);

COMMENT ON TABLE auto_shoutout_creators IS 'Manual list of creators to auto-shoutout';
COMMENT ON COLUMN auto_shoutout_creators.custom_trigger IS 'Per-creator trigger: default (use community settings), first_message, raid_only, manual_only';

-- Role-based auto-shoutout configuration
CREATE TABLE IF NOT EXISTS auto_shoutout_roles (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    role_name VARCHAR(50) NOT NULL, -- e.g., 'content_creator', 'vip', 'moderator'
    trigger_type VARCHAR(20) DEFAULT 'first_message', -- 'first_message', 'raid_only', 'both'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_auto_shoutout_roles_community ON auto_shoutout_roles(community_id);

COMMENT ON TABLE auto_shoutout_roles IS 'Roles that trigger auto-shoutout for their members';

-- Video shoutout history/tracking
CREATE TABLE IF NOT EXISTS video_shoutout_history (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    target_platform VARCHAR(20) NOT NULL,
    target_user_id VARCHAR(100) NOT NULL,
    target_username VARCHAR(100) NOT NULL,
    video_platform VARCHAR(20) NOT NULL, -- Platform video was fetched from (may differ from target_platform)
    video_id VARCHAR(100) NOT NULL,
    video_title VARCHAR(500),
    video_thumbnail_url TEXT,
    video_url TEXT,
    game_name VARCHAR(200), -- Last game/category played
    trigger_type VARCHAR(20) NOT NULL, -- 'manual', 'first_message', 'raid', 'host'
    triggered_by_user_id VARCHAR(100),
    triggered_by_username VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vso_history_community ON video_shoutout_history(community_id);
CREATE INDEX IF NOT EXISTS idx_vso_history_target ON video_shoutout_history(target_platform, target_user_id);
CREATE INDEX IF NOT EXISTS idx_vso_history_created ON video_shoutout_history(created_at);

COMMENT ON TABLE video_shoutout_history IS 'History of video shoutouts for analytics and cooldown tracking';
COMMENT ON COLUMN video_shoutout_history.video_platform IS 'Platform video was fetched from - may differ from target due to cross-platform fallback';
COMMENT ON COLUMN video_shoutout_history.game_name IS 'Last game/category the target was playing';

-- Trigger to update updated_at on shoutout_config
CREATE OR REPLACE TRIGGER update_shoutout_config_updated_at
    BEFORE UPDATE ON shoutout_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
