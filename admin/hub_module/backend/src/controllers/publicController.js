/**
 * Public Controller - No authentication required
 */
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';

/**
 * Get platform statistics
 */
export async function getStats(req, res, next) {
  try {
    // Get community count
    const communitiesResult = await query(
      'SELECT COUNT(*) as count FROM communities WHERE is_active = true'
    );

    // Initialize stats with defaults
    const stats = {
      communities: parseInt(communitiesResult.rows[0]?.count || 0, 10),
      discord: { servers: 0, channels: 0 },
      twitch: { channels: 0, live: 0, viewers: 0 },
      slack: { workspaces: 0, channels: 0 },
    };

    // Try to get platform counts from coordination table
    // This may fail if the table doesn't exist or has wrong schema
    try {
      const platformResult = await query(`
        SELECT
          platform,
          COUNT(DISTINCT server_id) as servers,
          COUNT(*) as channels,
          SUM(CASE WHEN is_live = true THEN 1 ELSE 0 END) as live,
          SUM(CASE WHEN is_live = true THEN viewer_count ELSE 0 END) as viewers
        FROM coordination
        WHERE platform IS NOT NULL
        GROUP BY platform
      `);

      for (const row of platformResult.rows) {
        switch (row.platform) {
          case 'discord':
            stats.discord = {
              servers: parseInt(row.servers || 0, 10),
              channels: parseInt(row.channels || 0, 10),
            };
            break;
          case 'twitch':
            stats.twitch = {
              channels: parseInt(row.channels || 0, 10),
              live: parseInt(row.live || 0, 10),
              viewers: parseInt(row.viewers || 0, 10),
            };
            break;
          case 'slack':
            stats.slack = {
              workspaces: parseInt(row.servers || 0, 10),
              channels: parseInt(row.channels || 0, 10),
            };
            break;
        }
      }
    } catch (coordErr) {
      // Log the error but return stats with zeros instead of failing
      console.error('Failed to fetch coordination stats:', coordErr.message);
      // Stats already initialized with zeros above
    }

    res.json({ success: true, stats });
  } catch (err) {
    next(err);
  }
}

// Valid community types for validation
const VALID_COMMUNITY_TYPES = ['shared_interest_group', 'gaming', 'creator', 'corporate', 'other'];

/**
 * List public communities with optional search and type filter
 */
export async function getCommunities(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '12', 10)));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const typeFilter = req.query.type || '';

    // Build WHERE clause
    let whereClause = 'WHERE is_active = true AND is_public = true';
    const params = [];
    let paramIndex = 1;

    // Add search filter
    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Add type filter (validate against allowed types)
    if (typeFilter && VALID_COMMUNITY_TYPES.includes(typeFilter)) {
      whereClause += ` AND community_type = $${paramIndex}`;
      params.push(typeFilter);
      paramIndex++;
    }

    // Get total count with filters
    const countResult = await query(
      `SELECT COUNT(*) as count FROM communities ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    // Get communities with filters
    const result = await query(`
      SELECT id, name, display_name, description, platform, platform_server_id,
             member_count, config, community_type, created_at
      FROM communities
      ${whereClause}
      ORDER BY member_count DESC, name ASC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, limit, offset]);

    const communities = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      logoUrl: row.config?.logo_url || null,
      primaryPlatform: row.platform,
      platformServerId: row.platform_server_id,
      memberCount: row.member_count || 0,
      communityType: row.community_type || 'creator',
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({
      success: true,
      communities,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get single community public info
 */
export async function getCommunity(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    const result = await query(`
      SELECT id, name, display_name, description, platform,
             member_count, config, join_mode, community_type, created_at
      FROM communities
      WHERE id = $1 AND is_active = true AND is_public = true
    `, [communityId]);

    if (result.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const row = result.rows[0];
    res.json({
      success: true,
      community: {
        id: row.id,
        name: row.name,
        displayName: row.display_name || row.name,
        description: row.description,
        logoUrl: row.config?.logo_url || null,
        bannerUrl: row.config?.banner_url || null,
        primaryPlatform: row.platform,
        memberCount: row.member_count || 0,
        joinMode: row.join_mode || 'open',
        communityType: row.community_type || 'creator',
        createdAt: row.created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get live Twitch streams
 */
export async function getLiveStreams(req, res, next) {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

    const result = await query(`
      SELECT c.entity_id, c.channel_id, c.server_id, c.viewer_count, c.live_since,
             c.stream_title, c.game_name, c.thumbnail_url
      FROM coordination c
      WHERE c.is_live = true AND c.platform = $1
      ORDER BY c.viewer_count DESC
      LIMIT $2
    `, ['twitch', limit]);

    const streams = result.rows.map(row => ({
      entityId: row.entity_id,
      channelName: row.channel_id || row.server_id,
      viewerCount: row.viewer_count || 0,
      liveSince: row.live_since?.toISOString(),
      title: row.stream_title || '',
      game: row.game_name || '',
      thumbnailUrl: row.thumbnail_url || '',
    }));

    res.json({
      success: true,
      streams,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get single stream details
 */
export async function getStreamDetails(req, res, next) {
  try {
    const { entityId } = req.params;

    const result = await query(`
      SELECT entity_id, platform, channel_id, server_id, is_live, viewer_count,
             live_since, last_updated, stream_title, game_name, thumbnail_url
      FROM coordination
      WHERE entity_id = $1
    `, [entityId]);

    if (result.rows.length === 0) {
      return next(errors.notFound('Stream not found'));
    }

    const row = result.rows[0];
    res.json({
      success: true,
      stream: {
        entityId: row.entity_id,
        platform: row.platform,
        channelName: row.channel_id || row.server_id,
        isLive: row.is_live,
        viewerCount: row.viewer_count || 0,
        liveSince: row.live_since?.toISOString(),
        lastActivity: row.last_updated?.toISOString(),
        title: row.stream_title || '',
        game: row.game_name || '',
        thumbnailUrl: row.thumbnail_url || '',
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get signup settings (public endpoint for login page)
 */
export async function getSignupSettings(req, res, next) {
  try {
    const result = await query(
      `SELECT setting_key, setting_value FROM hub_settings
       WHERE setting_key IN ('signup_enabled', 'email_configured', 'signup_allowed_domains')`
    );

    // Build settings object with defaults
    const settings = {
      signup_enabled: 'true',
      email_configured: 'false',
      signup_allowed_domains: '',
    };

    // Override with database values if they exist
    for (const row of result.rows) {
      settings[row.setting_key] = row.setting_value;
    }

    // Signup is only available if email is configured and signup is enabled
    const signupEnabled = settings.signup_enabled === 'true' && settings.email_configured === 'true';
    const allowedDomains = settings.signup_allowed_domains
      ? settings.signup_allowed_domains.split(',').map(d => d.trim()).filter(Boolean)
      : [];

    res.json({
      success: true,
      signupEnabled,
      hasAllowedDomains: allowedDomains.length > 0,
      allowedDomains: allowedDomains.length > 0 ? allowedDomains : null,
    });
  } catch (err) {
    next(err);
  }
}
