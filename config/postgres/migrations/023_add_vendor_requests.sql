-- Migration: Add Vendor Request System
-- Version: 023
-- Description: Tables for managing global vendor role requests

-- =============================================================================
-- Vendor Role Requests Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS vendor_role_requests (
    id SERIAL PRIMARY KEY,
    request_id VARCHAR(36) UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
    user_email VARCHAR(255) NOT NULL,
    user_display_name VARCHAR(255),

    -- Request Details
    company_name VARCHAR(255) NOT NULL,
    company_website VARCHAR(500),
    business_description TEXT NOT NULL,
    experience_summary TEXT,

    -- Contact Information
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(20),

    -- Request Status
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    reviewed_by INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
    admin_notes TEXT,

    -- Metadata
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- Indexes for Performance
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_vendor_role_requests_user_id ON vendor_role_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_role_requests_status ON vendor_role_requests(status);
CREATE INDEX IF NOT EXISTS idx_vendor_role_requests_requested_at ON vendor_role_requests(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_role_requests_reviewed_by ON vendor_role_requests(reviewed_by);

-- =============================================================================
-- Trigger: Update updated_at on vendor_role_requests
-- =============================================================================
CREATE OR REPLACE FUNCTION update_vendor_role_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_role_requests_updated_at ON vendor_role_requests;
CREATE TRIGGER vendor_role_requests_updated_at
BEFORE UPDATE ON vendor_role_requests
FOR EACH ROW
EXECUTE FUNCTION update_vendor_role_requests_updated_at();

-- =============================================================================
-- Comments/Documentation
-- =============================================================================
COMMENT ON TABLE vendor_role_requests IS 'Requests for global vendor role access from users';
COMMENT ON COLUMN vendor_role_requests.status IS 'Request workflow: pending → approved (grants is_vendor flag) OR rejected';

-- Migration Complete
