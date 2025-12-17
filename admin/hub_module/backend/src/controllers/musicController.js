/**
 * Music Controller
 * Manages community music settings, providers, and radio stations
 */
import { query, pool } from '../config/database.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

// Encryption utilities for OAuth tokens
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt sensitive data (OAuth tokens)
 */
function encryptData(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    data: encrypted,
    tag: authTag.toString('hex')
  });
}

/**
 * Decrypt sensitive data (OAuth tokens)
 */
function decryptData(encrypted) {
  if (!encrypted) return null;
  try {
    const { iv, data, tag } = JSON.parse(encrypted);
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      Buffer.from(iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    logger.error('Failed to decrypt data', { error: error.message });
    return null;
  }
}

/**
 * Get music settings for a community
 * GET /api/v1/admin/:communityId/music/settings
 */
export async function getMusicSettings(req, res) {
  const { communityId } = req.params;

  try {
    const result = await query(
      `SELECT id, community_id, default_provider, autoplay_enabled,
              volume_limit, allowed_genres, blocked_artists,
              require_dj_approval, is_active, created_at, updated_at
       FROM community_music_settings
       WHERE community_id = $1`,
      [communityId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Music settings not found'
      });
    }

    const settings = result.rows[0];
    res.json({
      success: true,
      settings: {
        id: settings.id,
        communityId: settings.community_id,
        defaultProvider: settings.default_provider,
        autoplayEnabled: settings.autoplay_enabled,
        volumeLimit: settings.volume_limit,
        allowedGenres: settings.allowed_genres,
        blockedArtists: settings.blocked_artists,
        requireDjApproval: settings.require_dj_approval,
        isActive: settings.is_active,
        createdAt: settings.created_at,
        updatedAt: settings.updated_at
      }
    });
  } catch (error) {
    logger.error('Error getting music settings', { communityId, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get music settings'
    });
  }
}

/**
 * Update music settings for a community
 * PUT /api/v1/admin/:communityId/music/settings
 */
export async function updateMusicSettings(req, res) {
  const { communityId } = req.params;
  const {
    defaultProvider,
    autoplayEnabled,
    volumeLimit,
    allowedGenres,
    blockedArtists,
    requireDjApproval,
    isActive
  } = req.body;

  try {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (defaultProvider !== undefined) {
      updates.push(`default_provider = $${paramIndex++}`);
      values.push(defaultProvider);
    }

    if (typeof autoplayEnabled === 'boolean') {
      updates.push(`autoplay_enabled = $${paramIndex++}`);
      values.push(autoplayEnabled);
    }

    if (volumeLimit !== undefined) {
      updates.push(`volume_limit = $${paramIndex++}`);
      values.push(Math.min(100, Math.max(0, parseInt(volumeLimit, 10))));
    }

    if (allowedGenres !== undefined) {
      updates.push(`allowed_genres = $${paramIndex++}`);
      values.push(JSON.stringify(Array.isArray(allowedGenres) ? allowedGenres : []));
    }

    if (blockedArtists !== undefined) {
      updates.push(`blocked_artists = $${paramIndex++}`);
      values.push(JSON.stringify(Array.isArray(blockedArtists) ? blockedArtists : []));
    }

    if (typeof requireDjApproval === 'boolean') {
      updates.push(`require_dj_approval = $${paramIndex++}`);
      values.push(requireDjApproval);
    }

    if (typeof isActive === 'boolean') {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(communityId);

    const result = await query(
      `UPDATE community_music_settings
       SET ${updates.join(', ')}
       WHERE community_id = $${paramIndex}
       RETURNING id, community_id, default_provider, autoplay_enabled,
                 volume_limit, allowed_genres, blocked_artists,
                 require_dj_approval, is_active, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Music settings not found'
      });
    }

    const settings = result.rows[0];
    logger.audit('Updated music settings', {
      communityId,
      userId: req.user?.id,
      changes: Object.keys({ defaultProvider, autoplayEnabled, volumeLimit, allowedGenres, blockedArtists, requireDjApproval, isActive }).filter(k => arguments[1][k] !== undefined)
    });

    res.json({
      success: true,
      settings: {
        id: settings.id,
        communityId: settings.community_id,
        defaultProvider: settings.default_provider,
        autoplayEnabled: settings.autoplay_enabled,
        volumeLimit: settings.volume_limit,
        allowedGenres: settings.allowed_genres,
        blockedArtists: settings.blocked_artists,
        requireDjApproval: settings.require_dj_approval,
        isActive: settings.is_active,
        createdAt: settings.created_at,
        updatedAt: settings.updated_at
      }
    });
  } catch (error) {
    logger.error('Error updating music settings', { communityId, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to update music settings'
    });
  }
}

/**
 * List configured music providers for a community
 * GET /api/v1/admin/:communityId/music/providers
 */
export async function getProviders(req, res) {
  const { communityId } = req.params;

  try {
    const result = await query(
      `SELECT id, community_id, provider_name, is_connected, is_active,
              oauth_expires_at, last_sync, config, created_at, updated_at
       FROM community_music_providers
       WHERE community_id = $1
       ORDER BY provider_name ASC`,
      [communityId]
    );

    const providers = result.rows.map(row => ({
      id: row.id,
      communityId: row.community_id,
      providerName: row.provider_name,
      isConnected: row.is_connected,
      isActive: row.is_active,
      oauthExpiresAt: row.oauth_expires_at,
      lastSync: row.last_sync,
      config: row.config ? JSON.parse(row.config) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({
      success: true,
      providers
    });
  } catch (error) {
    logger.error('Error getting music providers', { communityId, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get music providers'
    });
  }
}

/**
 * Start OAuth flow for a music provider
 * POST /api/v1/admin/:communityId/music/providers/:provider/oauth
 */
export async function startOAuth(req, res) {
  const { communityId, provider } = req.params;
  const { redirectUri } = req.body;

  if (!redirectUri) {
    return res.status(400).json({
      success: false,
      error: 'redirectUri is required'
    });
  }

  try {
    // Generate OAuth state token for CSRF protection
    const stateToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store state token in cache/database
    await query(
      `INSERT INTO oauth_state_tokens (community_id, provider, state_token, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [communityId, provider, stateToken, redirectUri, expiresAt]
    );

    // Build OAuth authorization URL based on provider
    let authUrl;
    switch (provider.toLowerCase()) {
      case 'spotify':
        authUrl = buildSpotifyAuthUrl(stateToken, communityId);
        break;
      case 'soundcloud':
        authUrl = buildSoundCloudAuthUrl(stateToken, communityId);
        break;
      case 'youtube':
        authUrl = buildYouTubeAuthUrl(stateToken, communityId);
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unsupported provider: ${provider}`
        });
    }

    logger.audit('Started OAuth flow', {
      communityId,
      provider,
      userId: req.user?.id
    });

    res.json({
      success: true,
      authUrl,
      stateToken
    });
  } catch (error) {
    logger.error('Error starting OAuth', { communityId, provider, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to start OAuth flow'
    });
  }
}

/**
 * Disconnect a music provider
 * DELETE /api/v1/admin/:communityId/music/providers/:provider
 */
export async function disconnectProvider(req, res) {
  const { communityId, provider } = req.params;

  try {
    const result = await query(
      `UPDATE community_music_providers
       SET is_connected = false, is_active = false, updated_at = NOW()
       WHERE community_id = $1 AND provider_name = $2
       RETURNING id, community_id, provider_name, is_connected, is_active,
                 oauth_expires_at, last_sync, config, created_at, updated_at`,
      [communityId, provider]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Provider not found'
      });
    }

    // Also clear stored OAuth tokens
    await query(
      `DELETE FROM oauth_tokens
       WHERE community_id = $1 AND provider = $2`,
      [communityId, provider]
    );

    logger.audit('Disconnected music provider', {
      communityId,
      provider,
      userId: req.user?.id
    });

    res.json({
      success: true,
      message: `${provider} provider disconnected`
    });
  } catch (error) {
    logger.error('Error disconnecting provider', { communityId, provider, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect provider'
    });
  }
}

/**
 * Get radio stations for a community
 * GET /api/v1/admin/:communityId/music/radio-stations
 */
export async function getRadioStations(req, res) {
  const { communityId } = req.params;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
  const offset = (page - 1) * limit;

  try {
    const countResult = await query(
      `SELECT COUNT(*) as count FROM community_radio_stations
       WHERE community_id = $1`,
      [communityId]
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const result = await query(
      `SELECT id, community_id, name, url, description, genre, is_active,
              created_by, created_at, updated_at
       FROM community_radio_stations
       WHERE community_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [communityId, limit, offset]
    );

    const stations = result.rows.map(row => ({
      id: row.id,
      communityId: row.community_id,
      name: row.name,
      url: row.url,
      description: row.description,
      genre: row.genre,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({
      success: true,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      stations
    });
  } catch (error) {
    logger.error('Error getting radio stations', { communityId, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get radio stations'
    });
  }
}

/**
 * Add a radio station to a community
 * POST /api/v1/admin/:communityId/music/radio-stations
 */
export async function addRadioStation(req, res) {
  const { communityId } = req.params;
  const { name, url, description, genre, isActive } = req.body;

  // Validate required fields
  if (!name || !url) {
    return res.status(400).json({
      success: false,
      error: 'name and url are required'
    });
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: 'Invalid URL format'
    });
  }

  try {
    const result = await query(
      `INSERT INTO community_radio_stations
       (community_id, name, url, description, genre, is_active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, community_id, name, url, description, genre, is_active,
                 created_by, created_at, updated_at`,
      [
        communityId,
        name.substring(0, 255),
        url,
        description ? description.substring(0, 1000) : null,
        genre ? genre.substring(0, 100) : null,
        typeof isActive === 'boolean' ? isActive : true,
        req.user?.id || null
      ]
    );

    const station = result.rows[0];
    logger.audit('Added radio station', {
      communityId,
      stationId: station.id,
      stationName: name,
      userId: req.user?.id
    });

    res.status(201).json({
      success: true,
      station: {
        id: station.id,
        communityId: station.community_id,
        name: station.name,
        url: station.url,
        description: station.description,
        genre: station.genre,
        isActive: station.is_active,
        createdBy: station.created_by,
        createdAt: station.created_at,
        updatedAt: station.updated_at
      }
    });
  } catch (error) {
    logger.error('Error adding radio station', { communityId, name, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to add radio station'
    });
  }
}

/**
 * Remove a radio station from a community
 * DELETE /api/v1/admin/:communityId/music/radio-stations/:id
 */
export async function removeRadioStation(req, res) {
  const { communityId, id } = req.params;

  try {
    const result = await query(
      `DELETE FROM community_radio_stations
       WHERE id = $1 AND community_id = $2
       RETURNING id, name`,
      [id, communityId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Radio station not found'
      });
    }

    logger.audit('Removed radio station', {
      communityId,
      stationId: id,
      stationName: result.rows[0].name,
      userId: req.user?.id
    });

    res.json({
      success: true,
      message: 'Radio station removed'
    });
  } catch (error) {
    logger.error('Error removing radio station', { communityId, id, error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to remove radio station'
    });
  }
}

/**
 * Helper: Build Spotify OAuth URL
 */
function buildSpotifyAuthUrl(stateToken, communityId) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.SPOTIFY_REDIRECT_URI || `https://api.waddlebot.io/oauth/spotify/callback`);
  const scope = encodeURIComponent('playlist-read-private playlist-read-collaborative');

  return `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&state=${stateToken}&community_id=${communityId}`;
}

/**
 * Helper: Build SoundCloud OAuth URL
 */
function buildSoundCloudAuthUrl(stateToken, communityId) {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.SOUNDCLOUD_REDIRECT_URI || `https://api.waddlebot.io/oauth/soundcloud/callback`);

  return `https://soundcloud.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=non-expiring&state=${stateToken}&community_id=${communityId}`;
}

/**
 * Helper: Build YouTube OAuth URL
 */
function buildYouTubeAuthUrl(stateToken, communityId) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.YOUTUBE_REDIRECT_URI || `https://api.waddlebot.io/oauth/youtube/callback`);
  const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.readonly');

  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&state=${stateToken}&community_id=${communityId}`;
}
