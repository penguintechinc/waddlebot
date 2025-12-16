-- Migration: Module controls for community admins
-- Allows community admins to enable/disable any module including core modules

-- Add is_core flag to modules table (if modules table exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'modules') THEN
        ALTER TABLE modules ADD COLUMN IF NOT EXISTS is_core BOOLEAN DEFAULT FALSE;

        -- Mark core modules
        UPDATE modules SET is_core = TRUE WHERE id IN (
            'reputation', 'loyalty', 'leaderboard', 'shoutout',
            'translation', 'ai_insights', 'analytics', 'browser_source',
            'identity', 'workflow'
        );
    END IF;
END $$;

-- Ensure module_installations table has proper structure
ALTER TABLE module_installations ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE module_installations ADD COLUMN IF NOT EXISTS disabled_by INTEGER REFERENCES hub_users(id);
ALTER TABLE module_installations ADD COLUMN IF NOT EXISTS disable_reason TEXT;

-- Create index for faster module status lookups
CREATE INDEX IF NOT EXISTS idx_module_installations_status
ON module_installations(community_id, module_id, is_enabled);

-- Ensure all communities have module_installations for core modules
-- This is a safe upsert that won't fail if modules table doesn't exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'modules') THEN
        INSERT INTO module_installations (community_id, module_id, is_enabled, config)
        SELECT c.id, m.id, TRUE, '{}'
        FROM communities c
        CROSS JOIN modules m
        WHERE m.is_core = TRUE
        ON CONFLICT (community_id, module_id) DO NOTHING;
    END IF;
END $$;

-- Add comment for documentation
COMMENT ON COLUMN module_installations.is_enabled IS 'Whether the module is enabled for this community. Admins can disable any module including core modules.';