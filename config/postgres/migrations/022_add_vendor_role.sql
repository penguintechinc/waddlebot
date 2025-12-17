-- Migration: Add Global Vendor Role Support
-- Version: 022
-- Description: Add is_vendor flag to hub_users for global vendor role management

-- Add is_vendor column to hub_users if not exists
ALTER TABLE hub_users
ADD COLUMN IF NOT EXISTS is_vendor BOOLEAN DEFAULT false;

-- Create index for vendor lookups
CREATE INDEX IF NOT EXISTS idx_hub_users_is_vendor ON hub_users(is_vendor);

-- Add comment
COMMENT ON COLUMN hub_users.is_vendor IS 'Flag indicating user has global vendor role for module submission and management';

-- Migration Complete
