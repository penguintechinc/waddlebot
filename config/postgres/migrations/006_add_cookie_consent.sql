-- Migration 006: Add Cookie Consent Tables (GDPR Compliance)
-- Required for EU users under GDPR regulations

-- =============================================================================
-- Cookie Consent Records
-- =============================================================================
CREATE TABLE IF NOT EXISTS cookie_consent (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES hub_users(id) ON DELETE CASCADE,
  session_id VARCHAR(255),
  consent_given BOOLEAN DEFAULT false,
  consent_version VARCHAR(50) NOT NULL,
  essential_cookies BOOLEAN DEFAULT true,
  functional_cookies BOOLEAN DEFAULT false,
  analytics_cookies BOOLEAN DEFAULT false,
  marketing_cookies BOOLEAN DEFAULT false,
  ip_address INET,
  user_agent TEXT,
  consent_timestamp TIMESTAMPTZ DEFAULT NOW(),
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, consent_version),
  UNIQUE(session_id)
);

CREATE INDEX IF NOT EXISTS idx_cookie_consent_user ON cookie_consent(user_id);
CREATE INDEX IF NOT EXISTS idx_cookie_consent_session ON cookie_consent(session_id);
CREATE INDEX IF NOT EXISTS idx_cookie_consent_timestamp ON cookie_consent(consent_timestamp DESC);

COMMENT ON TABLE cookie_consent IS 'GDPR cookie consent records per user/session';
COMMENT ON COLUMN cookie_consent.essential_cookies IS 'Always true - session, auth, security cookies';
COMMENT ON COLUMN cookie_consent.functional_cookies IS 'Optional - preferences, language, theme';
COMMENT ON COLUMN cookie_consent.analytics_cookies IS 'Optional - Google Analytics, performance monitoring';
COMMENT ON COLUMN cookie_consent.marketing_cookies IS 'Optional - ads, retargeting, conversion tracking';

-- =============================================================================
-- Cookie Consent Audit Log
-- =============================================================================
CREATE TABLE IF NOT EXISTS cookie_audit_log (
  id SERIAL PRIMARY KEY,
  consent_id INTEGER REFERENCES cookie_consent(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  old_preferences JSONB,
  new_preferences JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cookie_audit_consent ON cookie_audit_log(consent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cookie_audit_action ON cookie_audit_log(action, created_at DESC);

COMMENT ON TABLE cookie_audit_log IS 'Audit trail of all cookie consent changes for GDPR compliance';

-- =============================================================================
-- Cookie Policy Versions
-- =============================================================================
CREATE TABLE IF NOT EXISTS cookie_policy_versions (
  id SERIAL PRIMARY KEY,
  version VARCHAR(50) UNIQUE NOT NULL,
  content TEXT NOT NULL,
  effective_date DATE NOT NULL,
  is_current BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cookie_policy_current ON cookie_policy_versions(is_current)
  WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_cookie_policy_effective ON cookie_policy_versions(effective_date DESC);

COMMENT ON TABLE cookie_policy_versions IS 'Cookie policy versions - policy updates trigger re-consent';

-- =============================================================================
-- Insert Default Policy Version
-- =============================================================================
INSERT INTO cookie_policy_versions (version, content, effective_date, is_current) VALUES (
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
