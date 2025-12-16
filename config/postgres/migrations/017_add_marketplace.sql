-- Marketplace modules catalog
CREATE TABLE IF NOT EXISTS marketplace_modules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    category VARCHAR(100),
    developer_user_id INTEGER REFERENCES hub_users(id),

    -- External links (they host their own code)
    documentation_url VARCHAR(500),
    support_url VARCHAR(500),
    icon_url VARCHAR(500),

    -- Webhook configuration (where WE send requests)
    webhook_url VARCHAR(500) NOT NULL,
    webhook_secret VARCHAR(255) NOT NULL,  -- For HMAC signature verification
    webhook_timeout_ms INTEGER DEFAULT 5000,  -- Max 30000

    -- Triggers (what activates this module)
    trigger_commands TEXT[],  -- e.g., ['#weather', '#forecast'] (# prefix for marketplace)
    trigger_events TEXT[],    -- e.g., ['twitch.subscription', 'discord.member_join']

    -- Scopes & Response
    requested_scopes TEXT[],  -- e.g., ['send_message', 'overlay_write']
    response_types TEXT[],    -- e.g., ['text', 'overlay', 'browser_source']
    sample_response JSONB,    -- Example response for documentation

    -- Pricing
    pricing_type VARCHAR(50) DEFAULT 'free',  -- 'free', 'one_time', 'subscription'
    pricing_model VARCHAR(50) DEFAULT 'flat',  -- 'flat', 'per_seat'
    price_cents INTEGER DEFAULT 0,  -- For flat: total price; For per_seat: price per seat
    min_seats INTEGER DEFAULT 1,  -- Minimum seats for per_seat pricing
    billing_period VARCHAR(20) DEFAULT 'monthly',  -- 'monthly', 'yearly'
    currency VARCHAR(10) DEFAULT 'USD',
    stripe_price_id VARCHAR(255),
    paypal_plan_id VARCHAR(255),

    -- Status
    status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'suspended'
    approved_by INTEGER REFERENCES hub_users(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    last_health_check TIMESTAMPTZ,
    health_status VARCHAR(50) DEFAULT 'unknown',  -- 'healthy', 'unhealthy', 'unknown'

    -- Stats
    install_count INTEGER DEFAULT 0,
    rating_sum INTEGER DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    total_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,

    -- Metadata
    version VARCHAR(50) DEFAULT '1.0.0',
    screenshots JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Module submissions (for review workflow)
CREATE TABLE IF NOT EXISTS marketplace_submissions (
    id SERIAL PRIMARY KEY,
    module_id INTEGER REFERENCES marketplace_modules(id) ON DELETE CASCADE,
    version VARCHAR(50) NOT NULL,
    changes_description TEXT,
    submitted_by INTEGER REFERENCES hub_users(id),
    submitted_at TIMESTAMPTZ DEFAULT NOW(),

    -- Review
    status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'in_review', 'approved', 'rejected', 'changes_requested'
    reviewed_by INTEGER REFERENCES hub_users(id),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,

    -- Security scan
    security_scan_status VARCHAR(50),
    security_scan_results JSONB
);

-- Community subscriptions to marketplace modules
CREATE TABLE IF NOT EXISTS marketplace_subscriptions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    module_id INTEGER NOT NULL REFERENCES marketplace_modules(id),

    -- Subscription details
    status VARCHAR(50) DEFAULT 'active',  -- 'active', 'past_due', 'canceled', 'paused'
    is_enabled BOOLEAN DEFAULT TRUE,  -- Community can disable without canceling
    stripe_subscription_id VARCHAR(255),
    paypal_subscription_id VARCHAR(255),

    -- Per-seat tracking (if applicable)
    pricing_model VARCHAR(50) DEFAULT 'flat',  -- 'flat', 'per_seat'
    current_seat_count INTEGER,  -- Active members (last 30 days) for per-seat billing
    last_seat_update TIMESTAMPTZ,

    -- Billing
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,

    subscribed_at TIMESTAMPTZ DEFAULT NOW(),
    canceled_at TIMESTAMPTZ,

    UNIQUE(community_id, module_id)
);

-- Payment history
CREATE TABLE IF NOT EXISTS marketplace_payments (
    id SERIAL PRIMARY KEY,
    subscription_id INTEGER REFERENCES marketplace_subscriptions(id),
    community_id INTEGER NOT NULL REFERENCES communities(id),
    module_id INTEGER REFERENCES marketplace_modules(id),

    -- Payment details
    payment_provider VARCHAR(50) NOT NULL,  -- 'stripe', 'paypal'
    external_payment_id VARCHAR(255),
    amount_cents INTEGER NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    status VARCHAR(50) NOT NULL,  -- 'succeeded', 'failed', 'refunded', 'pending'

    -- Breakdown
    platform_fee_cents INTEGER DEFAULT 0,
    developer_amount_cents INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Premium feature offerings (chargeback model - always per-seat)
CREATE TABLE IF NOT EXISTS marketplace_premium_offerings (
    id SERIAL PRIMARY KEY,
    premium_user_id INTEGER NOT NULL REFERENCES hub_users(id),
    feature_name VARCHAR(255) NOT NULL,
    feature_description TEXT,

    -- Pricing (always per-seat for premium features)
    price_per_seat_cents INTEGER NOT NULL,  -- Price per community member
    min_seats INTEGER DEFAULT 1,
    billing_period VARCHAR(20) DEFAULT 'monthly',  -- 'monthly', 'yearly'
    currency VARCHAR(10) DEFAULT 'USD',
    revenue_split_percent INTEGER DEFAULT 70,  -- Premium holder gets this %, platform gets rest

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Community subscriptions to premium offerings (per-seat)
CREATE TABLE IF NOT EXISTS marketplace_premium_subscriptions (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    offering_id INTEGER NOT NULL REFERENCES marketplace_premium_offerings(id),
    status VARCHAR(50) DEFAULT 'active',

    -- Seat tracking
    current_seat_count INTEGER NOT NULL,  -- Community member count
    last_seat_update TIMESTAMPTZ DEFAULT NOW(),

    stripe_subscription_id VARCHAR(255),
    current_period_end TIMESTAMPTZ,

    subscribed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(community_id, offering_id)
);

-- Module ratings/reviews
CREATE TABLE IF NOT EXISTS marketplace_reviews (
    id SERIAL PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES marketplace_modules(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES hub_users(id),
    community_id INTEGER REFERENCES communities(id),

    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(module_id, user_id)
);

-- Marketplace platform settings (global admin configurable)
CREATE TABLE IF NOT EXISTS marketplace_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) NOT NULL UNIQUE,
    setting_value TEXT,
    updated_by INTEGER REFERENCES hub_users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default settings
INSERT INTO marketplace_settings (setting_key, setting_value) VALUES
    ('platform_fee_percent', '30'),
    ('base_terms_version', '1.0'),
    ('base_terms_content', 'Default marketplace terms and conditions...'),
    ('custom_addendum', ''),
    ('minimum_price_cents', '0'),
    ('payout_threshold_cents', '5000')  -- $50 minimum for payouts
ON CONFLICT (setting_key) DO NOTHING;

-- Terms & Conditions acceptance tracking
CREATE TABLE IF NOT EXISTS marketplace_tc_acceptance (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES hub_users(id),
    tc_version VARCHAR(50) NOT NULL,
    user_type VARCHAR(50) NOT NULL,  -- 'buyer', 'seller'
    accepted_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    UNIQUE(user_id, tc_version, user_type)
);

-- Seller registration (for tracking seller-specific info)
CREATE TABLE IF NOT EXISTS marketplace_sellers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES hub_users(id) UNIQUE,
    display_name VARCHAR(255),
    description TEXT,
    website_url VARCHAR(500),

    -- Payout info (encrypted in practice)
    payout_method VARCHAR(50),  -- 'stripe_connect', 'paypal'
    payout_account_id VARCHAR(255),

    -- Stats
    total_revenue_cents INTEGER DEFAULT 0,
    total_subscribers INTEGER DEFAULT 0,

    -- Status
    is_verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_marketplace_modules_status ON marketplace_modules(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_modules_category ON marketplace_modules(category);
CREATE INDEX IF NOT EXISTS idx_marketplace_modules_developer ON marketplace_modules(developer_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_community ON marketplace_subscriptions(community_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_module ON marketplace_subscriptions(module_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_enabled ON marketplace_subscriptions(is_enabled);
CREATE INDEX IF NOT EXISTS idx_marketplace_payments_community ON marketplace_payments(community_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_submissions_status ON marketplace_submissions(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_tc_acceptance_user ON marketplace_tc_acceptance(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_sellers_user ON marketplace_sellers(user_id);

-- Full-text search for modules
CREATE INDEX IF NOT EXISTS idx_marketplace_modules_search ON marketplace_modules
    USING GIN (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(category, '')));
