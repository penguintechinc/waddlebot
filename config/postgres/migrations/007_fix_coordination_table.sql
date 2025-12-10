-- Fix coordination table schema
-- This migration adds missing columns that were not included in 004_add_missing_tables.sql
-- The coordination table needs platform and server_id columns for the /api/v1/public/stats endpoint

-- Add missing columns if they don't exist
DO $$
BEGIN
    -- Add platform column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination' AND column_name = 'platform'
    ) THEN
        ALTER TABLE coordination ADD COLUMN platform VARCHAR(50);
        -- Mark existing rows with a default platform value
        UPDATE coordination SET platform = 'unknown' WHERE platform IS NULL;
        -- Now make it NOT NULL
        ALTER TABLE coordination ALTER COLUMN platform SET NOT NULL;
    END IF;

    -- Add server_id column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination' AND column_name = 'server_id'
    ) THEN
        ALTER TABLE coordination ADD COLUMN server_id VARCHAR(255);
    END IF;

    -- Add channel_name column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination' AND column_name = 'channel_name'
    ) THEN
        ALTER TABLE coordination ADD COLUMN channel_name VARCHAR(255);
    END IF;

    -- Add thumbnail_url column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination' AND column_name = 'thumbnail_url'
    ) THEN
        ALTER TABLE coordination ADD COLUMN thumbnail_url TEXT;
    END IF;

    -- Rename started_at to live_since if it exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination' AND column_name = 'started_at'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination' AND column_name = 'live_since'
    ) THEN
        ALTER TABLE coordination RENAME COLUMN started_at TO live_since;
    END IF;

    -- Change entity_id from INTEGER to VARCHAR(255) if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'coordination'
        AND column_name = 'entity_id'
        AND data_type = 'integer'
    ) THEN
        ALTER TABLE coordination ALTER COLUMN entity_id TYPE VARCHAR(255) USING entity_id::VARCHAR(255);
    END IF;
END $$;

-- Drop the old unique constraint on entity_id if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'coordination'
        AND constraint_name = 'coordination_entity_id_key'
    ) THEN
        ALTER TABLE coordination DROP CONSTRAINT coordination_entity_id_key;
    END IF;
END $$;

-- Add the correct unique constraint on (platform, channel_id) if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'coordination'
        AND constraint_name = 'coordination_platform_channel_id_key'
    ) THEN
        -- Only add if there are no duplicate records
        IF NOT EXISTS (
            SELECT platform, channel_id
            FROM coordination
            WHERE platform IS NOT NULL AND channel_id IS NOT NULL
            GROUP BY platform, channel_id
            HAVING COUNT(*) > 1
        ) THEN
            ALTER TABLE coordination ADD CONSTRAINT coordination_platform_channel_id_key UNIQUE (platform, channel_id);
        ELSE
            RAISE NOTICE 'Cannot add unique constraint - duplicate records exist';
        END IF;
    END IF;
END $$;

-- Create missing indexes
CREATE INDEX IF NOT EXISTS idx_coordination_platform ON coordination(platform);
CREATE INDEX IF NOT EXISTS idx_coordination_server ON coordination(server_id);

-- Drop the entity_id index if the entity column was changed
DROP INDEX IF EXISTS idx_coordination_entity;

COMMENT ON TABLE coordination IS 'Real-time stream coordination and status tracking across platforms';
