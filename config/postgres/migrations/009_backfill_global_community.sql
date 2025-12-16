-- Migration: Backfill all existing users into global community
-- This ensures all users are members of the global community for cross-community reputation tracking

-- Add all existing users to global community if not already members
INSERT INTO community_members (community_id, user_id, role, is_active, joined_at)
SELECT
    (SELECT id FROM communities WHERE is_global = TRUE LIMIT 1),
    u.id,
    'member',
    TRUE,
    NOW()
FROM hub_users u
WHERE NOT EXISTS (
    SELECT 1 FROM community_members cm
    WHERE cm.user_id = u.id
    AND cm.community_id = (SELECT id FROM communities WHERE is_global = TRUE)
)
ON CONFLICT (community_id, user_id) DO UPDATE SET is_active = TRUE;

-- Update member count for global community
UPDATE communities SET member_count = (
    SELECT COUNT(*) FROM community_members WHERE community_id = communities.id AND is_active = TRUE
) WHERE is_global = TRUE;

-- Log the migration
DO $$
DECLARE
    affected_count INTEGER;
BEGIN
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    RAISE NOTICE 'Backfilled % users into global community', affected_count;
END $$;
