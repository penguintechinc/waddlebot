/**
 * Stream Controller - Live stream endpoints
 */
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Get live streams for a community
 */
export async function getLiveStreams(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Verify user is a member of the community
    const memberCheck = await query(
      `SELECT id FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, req.user.id]
    );

    if (memberCheck.rows.length === 0) {
      return next(errors.forbidden('Not a member of this community'));
    }

    // Get live streams from coordination table via linked community_servers
    const result = await query(
      `SELECT
        co.entity_id,
        co.platform,
        co.server_id,
        co.channel_id,
        co.channel_name,
        co.is_live,
        co.live_since,
        co.viewer_count,
        co.stream_title,
        co.game_name,
        co.thumbnail_url
       FROM coordination co
       JOIN community_servers cs ON cs.platform = co.platform AND cs.platform_server_id = co.server_id
       WHERE cs.community_id = $1
         AND cs.status = 'approved'
         AND co.platform = 'twitch'
         AND co.is_live = true
       ORDER BY co.viewer_count DESC`,
      [communityId]
    );

    const streams = result.rows.map(row => ({
      entityId: row.entity_id,
      platform: row.platform,
      channelId: row.channel_id,
      channelName: row.channel_name || row.channel_id,
      isLive: row.is_live,
      liveSince: row.live_since?.toISOString(),
      viewerCount: row.viewer_count || 0,
      title: row.stream_title || '',
      game: row.game_name || '',
      thumbnailUrl: row.thumbnail_url || '',
    }));

    logger.info('Fetched live streams', {
      communityId,
      userId: req.user.id,
      streamCount: streams.length,
    });

    res.json({ success: true, streams });
  } catch (err) {
    logger.error('Failed to fetch live streams', { error: err.message });
    next(err);
  }
}

/**
 * Get featured/pinned streams for a community
 * Currently returns top streams by viewer count
 */
export async function getFeaturedStreams(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Verify user is a member of the community
    const memberCheck = await query(
      `SELECT id FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, req.user.id]
    );

    if (memberCheck.rows.length === 0) {
      return next(errors.forbidden('Not a member of this community'));
    }

    // Get featured streams (top streams by viewer count)
    const result = await query(
      `SELECT
        co.entity_id,
        co.platform,
        co.server_id,
        co.channel_id,
        co.channel_name,
        co.is_live,
        co.live_since,
        co.viewer_count,
        co.stream_title,
        co.game_name,
        co.thumbnail_url
       FROM coordination co
       JOIN community_servers cs ON cs.platform = co.platform AND cs.platform_server_id = co.server_id
       WHERE cs.community_id = $1
         AND cs.status = 'approved'
         AND co.platform = 'twitch'
         AND co.is_live = true
       ORDER BY co.viewer_count DESC
       LIMIT 5`,
      [communityId]
    );

    const streams = result.rows.map(row => ({
      entityId: row.entity_id,
      platform: row.platform,
      channelId: row.channel_id,
      channelName: row.channel_name || row.channel_id,
      isLive: row.is_live,
      liveSince: row.live_since?.toISOString(),
      viewerCount: row.viewer_count || 0,
      title: row.stream_title || '',
      game: row.game_name || '',
      thumbnailUrl: row.thumbnail_url || '',
    }));

    logger.info('Fetched featured streams', {
      communityId,
      userId: req.user.id,
      streamCount: streams.length,
    });

    res.json({ success: true, streams });
  } catch (err) {
    logger.error('Failed to fetch featured streams', { error: err.message });
    next(err);
  }
}

/**
 * Get details for a specific stream
 */
export async function getStreamDetails(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const entityId = req.params.entityId;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Verify user is a member of the community
    const memberCheck = await query(
      `SELECT id FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, req.user.id]
    );

    if (memberCheck.rows.length === 0) {
      return next(errors.forbidden('Not a member of this community'));
    }

    // Get stream details
    const result = await query(
      `SELECT
        co.entity_id,
        co.platform,
        co.server_id,
        co.channel_id,
        co.channel_name,
        co.is_live,
        co.live_since,
        co.viewer_count,
        co.stream_title,
        co.game_name,
        co.thumbnail_url,
        co.last_updated
       FROM coordination co
       JOIN community_servers cs ON cs.platform = co.platform AND cs.platform_server_id = co.server_id
       WHERE cs.community_id = $1 AND co.entity_id = $2 AND cs.status = 'approved'`,
      [communityId, entityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Stream not found'));
    }

    const row = result.rows[0];

    const stream = {
      entityId: row.entity_id,
      platform: row.platform,
      channelId: row.channel_id,
      channelName: row.channel_name || row.channel_id,
      isLive: row.is_live,
      liveSince: row.live_since?.toISOString(),
      viewerCount: row.viewer_count || 0,
      lastActivity: row.last_updated?.toISOString(),
      title: row.stream_title || '',
      game: row.game_name || '',
      thumbnailUrl: row.thumbnail_url || '',
    };

    logger.info('Fetched stream details', {
      communityId,
      entityId,
      userId: req.user.id,
    });

    res.json({ success: true, stream });
  } catch (err) {
    logger.error('Failed to fetch stream details', { error: err.message });
    next(err);
  }
}
