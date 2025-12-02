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

    // Get platform counts from coordination table
    const platformResult = await query(`
      SELECT
        platform,
        COUNT(DISTINCT server_id) as servers,
        COUNT(*) as channels,
        SUM(CASE WHEN is_live = true THEN 1 ELSE 0 END) as live,
        SUM(CASE WHEN is_live = true THEN viewer_count ELSE 0 END) as viewers
      FROM coordination
      GROUP BY platform
    `);

    const stats = {
      communities: parseInt(communitiesResult.rows[0]?.count || 0, 10),
      discord: { servers: 0, channels: 0 },
      twitch: { channels: 0, live: 0, viewers: 0 },
      slack: { workspaces: 0, channels: 0 },
    };

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

    res.json({ success: true, stats });
  } catch (err) {
    next(err);
  }
}

/**
 * List public communities
 */
export async function getCommunities(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '12', 10)));
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await query(
      'SELECT COUNT(*) as count FROM communities WHERE is_active = true AND is_public = true'
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    // Get communities
    const result = await query(`
      SELECT id, name, display_name, description, logo_url, primary_platform,
             member_count, created_at
      FROM communities
      WHERE is_active = true AND is_public = true
      ORDER BY member_count DESC, name ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const communities = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      logoUrl: row.logo_url,
      primaryPlatform: row.primary_platform,
      memberCount: row.member_count || 0,
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
      SELECT id, name, display_name, description, logo_url, banner_url,
             primary_platform, member_count, created_at
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
        logoUrl: row.logo_url,
        bannerUrl: row.banner_url,
        primaryPlatform: row.primary_platform,
        memberCount: row.member_count || 0,
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
    const communityId = req.query.communityId ? parseInt(req.query.communityId, 10) : null;

    let whereClause = 'WHERE c.is_live = true AND c.platform = $1';
    const params = ['twitch'];

    if (communityId) {
      whereClause += ' AND c.community_id = $2';
      params.push(communityId);
    }

    const result = await query(`
      SELECT c.entity_id, c.channel_id, c.server_id, c.viewer_count, c.live_since,
             c.stream_title, c.game_name, c.thumbnail_url, c.metadata
      FROM coordination c
      ${whereClause}
      ORDER BY c.viewer_count DESC
      LIMIT $${params.length + 1}
    `, [...params, limit]);

    const streams = result.rows.map(row => ({
      entityId: row.entity_id,
      channelName: row.channel_id || row.server_id,
      viewerCount: row.viewer_count || 0,
      liveSince: row.live_since?.toISOString(),
      title: row.stream_title || row.metadata?.title || '',
      game: row.game_name || row.metadata?.game || '',
      thumbnailUrl: row.thumbnail_url || row.metadata?.thumbnail_url || '',
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
             live_since, last_activity, stream_title, game_name, thumbnail_url, metadata
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
        lastActivity: row.last_activity?.toISOString(),
        title: row.stream_title || row.metadata?.title || '',
        game: row.game_name || row.metadata?.game || '',
        thumbnailUrl: row.thumbnail_url || row.metadata?.thumbnail_url || '',
        profileImage: row.metadata?.profile_image || '',
      },
    });
  } catch (err) {
    next(err);
  }
}
