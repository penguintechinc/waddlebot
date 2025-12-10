-- Migration 008: Add community types
-- Communities can be categorized by type for feature gating (e.g., shoutouts only for Creator/Gaming)

-- Create community type enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'community_type') THEN
        CREATE TYPE community_type AS ENUM (
            'shared_interest_group',
            'gaming',
            'creator',
            'corporate',
            'other'
        );
    END IF;
END
$$;

-- Add community_type column to communities table
ALTER TABLE communities
ADD COLUMN IF NOT EXISTS community_type community_type NOT NULL DEFAULT 'creator';

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_communities_type ON communities(community_type);

-- Comment
COMMENT ON COLUMN communities.community_type IS 'Community type: shared_interest_group, gaming, creator, corporate, other. Default: creator. Certain features (shoutouts) only available for creator/gaming types.';
