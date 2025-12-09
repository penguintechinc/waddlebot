-- Migration 002: Add Commands Registry Table
-- For dynamic command registration and routing

CREATE TABLE IF NOT EXISTS commands (
    id SERIAL PRIMARY KEY,
    command VARCHAR(100) NOT NULL,
    module_name VARCHAR(255) NOT NULL,
    description TEXT,
    usage TEXT,
    category VARCHAR(100) DEFAULT 'general',
    permission_level VARCHAR(50) DEFAULT 'everyone',
    cooldown_seconds INTEGER DEFAULT 0,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT true,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(command, community_id)
);

-- Index for command lookups
CREATE INDEX IF NOT EXISTS idx_commands_lookup
  ON commands(command, community_id)
  WHERE is_active = true AND is_enabled = true;

-- Index for community commands
CREATE INDEX IF NOT EXISTS idx_commands_community
  ON commands(community_id, category)
  WHERE is_active = true;

-- Index for global commands
CREATE INDEX IF NOT EXISTS idx_commands_global
  ON commands(command)
  WHERE community_id IS NULL AND is_active = true;

-- Analyze
ANALYZE commands;
