-- WaddleBot Development Database Initialization
-- This script sets up the basic database structure for development

-- Grant replication permissions to waddlebot user for read replicas
ALTER USER waddlebot WITH REPLICATION;

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

-- Initialize default hub settings for signup configuration
INSERT INTO hub_settings (setting_key, setting_value, updated_at) VALUES
    ('signup_enabled', 'true', NOW()),
    ('email_configured', 'false', NOW()),
    ('signup_allowed_domains', '', NOW())
ON CONFLICT (setting_key) DO NOTHING;


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

