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

    // Get live streams from coordination table
    const result = await query(
      `SELECT
        c.entity_id,
        c.platform,
        c.server_id,
        c.channel_id,
        c.is_live,
        c.live_since,
        c.viewer_count,
        c.metadata,
        s.server_id as twitch_channel_name
       FROM coordination c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.community_id = $1
         AND c.platform = 'twitch'
         AND c.is_live = true
       ORDER BY c.viewer_count DESC`,
      [communityId]
    );

    const streams = result.rows.map(row => {
      const metadata = row.metadata || {};
      return {
        entityId: row.entity_id,
        platform: row.platform,
        channelId: row.channel_id,
        channelName: row.twitch_channel_name || row.channel_id,
        isLive: row.is_live,
        liveSince: row.live_since?.toISOString(),
        viewerCount: row.viewer_count || 0,
        title: metadata.stream_title || metadata.title || '',
        game: metadata.game_name || metadata.game || '',
        thumbnailUrl: metadata.thumbnail_url || '',
        language: metadata.language || 'en',
      };
    });

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

    // Get featured streams (streams with priority > 0)
    const result = await query(
      `SELECT
        c.entity_id,
        c.platform,
        c.server_id,
        c.channel_id,
        c.is_live,
        c.live_since,
        c.viewer_count,
        c.priority,
        c.metadata,
        s.server_id as twitch_channel_name
       FROM coordination c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.community_id = $1
         AND c.platform = 'twitch'
         AND c.is_live = true
         AND c.priority > 0
       ORDER BY c.priority DESC, c.viewer_count DESC`,
      [communityId]
    );

    const streams = result.rows.map(row => {
      const metadata = row.metadata || {};
      return {
        entityId: row.entity_id,
        platform: row.platform,
        channelId: row.channel_id,
        channelName: row.twitch_channel_name || row.channel_id,
        isLive: row.is_live,
        liveSince: row.live_since?.toISOString(),
        viewerCount: row.viewer_count || 0,
        priority: row.priority || 0,
        title: metadata.stream_title || metadata.title || '',
        game: metadata.game_name || metadata.game || '',
        thumbnailUrl: metadata.thumbnail_url || '',
        language: metadata.language || 'en',
      };
    });

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
        c.entity_id,
        c.platform,
        c.server_id,
        c.channel_id,
        c.is_live,
        c.live_since,
        c.viewer_count,
        c.priority,
        c.metadata,
        c.last_activity,
        s.server_id as twitch_channel_name
       FROM coordination c
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE c.community_id = $1 AND c.entity_id = $2`,
      [communityId, entityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Stream not found'));
    }

    const row = result.rows[0];
    const metadata = row.metadata || {};

    const stream = {
      entityId: row.entity_id,
      platform: row.platform,
      channelId: row.channel_id,
      channelName: row.twitch_channel_name || row.channel_id,
      isLive: row.is_live,
      liveSince: row.live_since?.toISOString(),
      viewerCount: row.viewer_count || 0,
      priority: row.priority || 0,
      lastActivity: row.last_activity?.toISOString(),
      title: metadata.stream_title || metadata.title || '',
      game: metadata.game_name || metadata.game || '',
      thumbnailUrl: metadata.thumbnail_url || '',
      language: metadata.language || 'en',
      tags: metadata.tags || [],
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
