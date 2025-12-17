-- Migration 006: Add Cookie Consent Tables (GDPR Compliance)
-- Required for EU users under GDPR regulations

-- =============================================================================
-- Cookie Consent Records
-- =============================================================================
CREATE TABLE IF NOT EXISTS cookie_consent (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
  consent_id VARCHAR(255) UNIQUE NOT NULL,
  preferences JSONB NOT NULL DEFAULT '{"necessary": true, "functional": false, "analytics": false, "marketing": false}',
  consent_version VARCHAR(50) NOT NULL,
  consent_method VARCHAR(50) DEFAULT 'banner',
  ip_address INET,
  user_agent TEXT,
  consented_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '12 months')
);

CREATE INDEX IF NOT EXISTS idx_cookie_consent_user ON cookie_consent(user_id);
CREATE INDEX IF NOT EXISTS idx_cookie_consent_consent_id ON cookie_consent(consent_id);
CREATE INDEX IF NOT EXISTS idx_cookie_consent_updated ON cookie_consent(updated_at DESC);

COMMENT ON TABLE cookie_consent IS 'GDPR cookie consent records per user/session';
COMMENT ON COLUMN cookie_consent.preferences IS 'JSONB with necessary, functional, analytics, marketing booleans';
COMMENT ON COLUMN cookie_consent.consent_method IS 'How consent was given: banner, settings, etc.';

-- =============================================================================
-- Cookie Consent Audit Log
-- =============================================================================
CREATE TABLE IF NOT EXISTS cookie_audit_log (
  id SERIAL PRIMARY KEY,
  consent_id VARCHAR(255),
  user_id INTEGER REFERENCES hub_users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  category VARCHAR(50),
  previous_value BOOLEAN,
  new_value BOOLEAN,
  consent_version VARCHAR(50),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cookie_audit_consent ON cookie_audit_log(consent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cookie_audit_user ON cookie_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cookie_audit_action ON cookie_audit_log(action, created_at DESC);

COMMENT ON TABLE cookie_audit_log IS 'Audit trail of all cookie consent changes for GDPR compliance';

-- =============================================================================
-- Cookie Policy Versions
-- =============================================================================
CREATE TABLE IF NOT EXISTS cookie_policy_versions (
  id SERIAL PRIMARY KEY,
  version VARCHAR(50) UNIQUE NOT NULL,
  content TEXT NOT NULL,
  changes_summary TEXT,
  is_active BOOLEAN DEFAULT false,
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cookie_policy_active ON cookie_policy_versions(is_active)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_cookie_policy_effective ON cookie_policy_versions(effective_date DESC);

COMMENT ON TABLE cookie_policy_versions IS 'Cookie policy versions - policy updates trigger re-consent';

-- =============================================================================
-- Insert Default Policy Version
-- =============================================================================
INSERT INTO cookie_policy_versions (version, content, effective_date, is_active) VALUES (
  '1.0',
  'This website uses cookies to enhance your browsing experience. We use essential cookies for authentication and security, and optional cookies for analytics and functionality. You can customize your cookie preferences at any time.',
  CURRENT_DATE,
  true
) ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Analyze tables to update statistics
-- =============================================================================
ANALYZE cookie_consent;
ANALYZE cookie_audit_log;
ANALYZE cookie_policy_versions;

-- Migration Complete
