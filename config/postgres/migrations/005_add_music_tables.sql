-- Migration 005: Add Music Module Tables
-- For Spotify and YouTube Music integration

-- OAuth tokens for music services
CREATE TABLE IF NOT EXISTS music_oauth_tokens (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL CHECK (platform IN ('spotify', 'youtube')),
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type VARCHAR(50) DEFAULT 'Bearer',
    expires_at TIMESTAMP NOT NULL,
    scope TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Only one token per community/platform combination
    UNIQUE(community_id, platform)
);

-- Index for token lookups
CREATE INDEX idx_music_oauth_tokens_lookup
    ON music_oauth_tokens(community_id, platform);

-- Music playback state (current track, queue, etc.)
-- NOTE: YouTube Music plays through browser_source_core_module overlay
-- Spotify uses native Spotify Web Playback SDK
CREATE TABLE IF NOT EXISTS music_playback_state (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL CHECK (platform IN ('spotify', 'youtube')),
    current_track JSONB,
    queue JSONB DEFAULT '[]'::jsonb,
    is_playing BOOLEAN DEFAULT FALSE,
    volume INTEGER DEFAULT 50 CHECK (volume >= 0 AND volume <= 100),
    repeat_mode VARCHAR(20) DEFAULT 'off' CHECK (repeat_mode IN ('off', 'track', 'context')),
    shuffle BOOLEAN DEFAULT FALSE,
    browser_source_active BOOLEAN DEFAULT FALSE,  -- For YouTube: is overlay active
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Only one state per community/platform combination
    UNIQUE(community_id, platform)
);

-- Music settings per community
CREATE TABLE IF NOT EXISTS music_settings (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL CHECK (platform IN ('spotify', 'youtube')),

    -- DMCA compliance settings
    dmca_friendly BOOLEAN DEFAULT TRUE,
    allow_explicit_content BOOLEAN DEFAULT FALSE,

    -- Platform-specific settings
    require_music_category BOOLEAN DEFAULT FALSE,  -- For YouTube: require Music category
    max_song_duration_seconds INTEGER DEFAULT 600,  -- 10 minutes default
    allow_user_requests BOOLEAN DEFAULT TRUE,
    max_requests_per_user INTEGER DEFAULT 3,

    -- Filters
    blocked_artists TEXT[],
    blocked_genres TEXT[],
    allowed_playlists TEXT[],

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Only one settings per community/platform combination
    UNIQUE(community_id, platform)
);

CREATE INDEX idx_music_settings_lookup
    ON music_settings(community_id, platform);

-- Index for playback state lookups
CREATE INDEX idx_music_playback_state_lookup
    ON music_playback_state(community_id, platform);

-- Music playback history (for analytics and "recently played")
CREATE TABLE IF NOT EXISTS music_playback_history (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    track_id VARCHAR(255) NOT NULL,
    track_name VARCHAR(500),
    artist_name VARCHAR(500),
    album_name VARCHAR(500),
    duration_ms INTEGER,
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    played_by_username VARCHAR(255),
    played_by_user_id INTEGER
);

-- Indexes for playback history
CREATE INDEX idx_music_playback_history_community
    ON music_playback_history(community_id, played_at DESC);
CREATE INDEX idx_music_playback_history_track
    ON music_playback_history(community_id, track_id);
CREATE INDEX idx_music_playback_history_user
    ON music_playback_history(played_by_user_id, community_id);

-- Music playlists (community-managed playlists)
CREATE TABLE IF NOT EXISTS music_playlists (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    playlist_name VARCHAR(255) NOT NULL,
    playlist_description TEXT,
    platform_playlist_id VARCHAR(255),  -- External platform playlist ID
    tracks JSONB DEFAULT '[]'::jsonb,
    created_by_username VARCHAR(255) NOT NULL,
    created_by_user_id INTEGER,
    is_collaborative BOOLEAN DEFAULT FALSE,
    is_public BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for playlists
CREATE INDEX idx_music_playlists_community
    ON music_playlists(community_id, created_at DESC);
CREATE INDEX idx_music_playlists_creator
    ON music_playlists(created_by_user_id, community_id);

-- Song requests (queue management with voting)
CREATE TABLE IF NOT EXISTS music_song_requests (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    track_id VARCHAR(255) NOT NULL,
    track_name VARCHAR(500),
    artist_name VARCHAR(500),
    album_name VARCHAR(500),
    duration_ms INTEGER,
    requested_by_username VARCHAR(255) NOT NULL,
    requested_by_user_id INTEGER,
    votes INTEGER DEFAULT 1,
    is_played BOOLEAN DEFAULT FALSE,
    played_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for song requests
CREATE INDEX idx_music_song_requests_pending
    ON music_song_requests(community_id, votes DESC, created_at ASC)
    WHERE is_played = FALSE;
CREATE INDEX idx_music_song_requests_community
    ON music_song_requests(community_id, created_at DESC);

-- Song request votes (prevent duplicate voting)
CREATE TABLE IF NOT EXISTS music_song_request_votes (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES music_song_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    username VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(request_id, user_id)
);

CREATE INDEX idx_music_song_request_votes_lookup
    ON music_song_request_votes(request_id, user_id);

-- Analyze tables
ANALYZE music_oauth_tokens;
ANALYZE music_playback_state;
ANALYZE music_settings;
ANALYZE music_playback_history;
ANALYZE music_playlists;
ANALYZE music_song_requests;
ANALYZE music_song_request_votes;
