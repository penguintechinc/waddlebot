/**
 * Activity Controller - User activity tracking and leaderboard endpoints
 */
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Record a watch session event (join/leave stream)
 * Called by trigger modules when viewer joins/leaves
 */
export async function recordWatchSession(req, res, next) {
  try {
    const {
      eventType,
      communityId,
      platform,
      platformUserId,
      platformUsername,
      channelId,
    } = req.body;

    if (!eventType || !communityId || !platform || !platformUserId || !channelId) {
      return next(errors.badRequest('Missing required fields: eventType, communityId, platform, platformUserId, channelId'));
    }

    if (!['join', 'leave', 'heartbeat'].includes(eventType)) {
      return next(errors.badRequest('eventType must be join, leave, or heartbeat'));
    }

    // Try to find linked hub user
    const identityResult = await query(
      `SELECT hub_user_id FROM hub_user_identities
       WHERE platform = $1 AND platform_user_id = $2`,
      [platform, platformUserId]
    );
    const hubUserId = identityResult.rows[0]?.hub_user_id || null;

    if (eventType === 'join') {
      // Check for existing active session
      const existingSession = await query(
        `SELECT id FROM activity_watch_sessions
         WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
         AND channel_id = $4 AND is_active = true`,
        [communityId, platform, platformUserId, channelId]
      );

      if (existingSession.rows.length > 0) {
        // Update existing session heartbeat
        await query(
          `UPDATE activity_watch_sessions SET updated_at = NOW()
           WHERE id = $1`,
          [existingSession.rows[0].id]
        );
      } else {
        // Create new session
        await query(
          `INSERT INTO activity_watch_sessions
           (community_id, hub_user_id, platform, platform_user_id, platform_username, channel_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [communityId, hubUserId, platform, platformUserId, platformUsername, channelId]
        );
      }
    } else if (eventType === 'leave') {
      // Close active session
      const result = await query(
        `UPDATE activity_watch_sessions
         SET is_active = false,
             session_end = NOW(),
             duration_seconds = EXTRACT(EPOCH FROM (NOW() - session_start))::INTEGER,
             updated_at = NOW()
         WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
         AND channel_id = $4 AND is_active = true
         RETURNING id, duration_seconds`,
        [communityId, platform, platformUserId, channelId]
      );

      if (result.rows.length > 0) {
        // Update daily stats
        const duration = result.rows[0].duration_seconds || 0;
        await updateDailyStats(communityId, hubUserId, platformUserId, platformUsername, duration, 0);
      }
    } else if (eventType === 'heartbeat') {
      // Update session heartbeat timestamp
      await query(
        `UPDATE activity_watch_sessions SET updated_at = NOW()
         WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
         AND channel_id = $4 AND is_active = true`,
        [communityId, platform, platformUserId, channelId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Error recording watch session', { error: err.message });
    next(err);
  }
}

/**
 * Record a message event
 * Called by router when processing chat messages
 */
export async function recordMessage(req, res, next) {
  try {
    const {
      communityId,
      platform,
      platformUserId,
      platformUsername,
      channelId,
    } = req.body;

    if (!communityId || !platform || !platformUserId) {
      return next(errors.badRequest('Missing required fields: communityId, platform, platformUserId'));
    }

    // Try to find linked hub user
    const identityResult = await query(
      `SELECT hub_user_id FROM hub_user_identities
       WHERE platform = $1 AND platform_user_id = $2`,
      [platform, platformUserId]
    );
    const hubUserId = identityResult.rows[0]?.hub_user_id || null;

    // Insert message event
    await query(
      `INSERT INTO activity_message_events
       (community_id, hub_user_id, platform, platform_user_id, platform_username, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [communityId, hubUserId, platform, platformUserId, platformUsername, channelId]
    );

    // Update daily stats
    await updateDailyStats(communityId, hubUserId, platformUserId, platformUsername, 0, 1);

    res.json({ success: true });
  } catch (err) {
    logger.error('Error recording message', { error: err.message });
    next(err);
  }
}

/**
 * Batch record activity events
 * For high-volume event ingestion
 */
export async function recordActivityBatch(req, res, next) {
  try {
    const { events } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return next(errors.badRequest('events must be a non-empty array'));
    }

    if (events.length > 100) {
      return next(errors.badRequest('Maximum 100 events per batch'));
    }

    let processed = 0;
    let failed = 0;

    for (const event of events) {
      try {
        if (event.type === 'message') {
          const identityResult = await query(
            `SELECT hub_user_id FROM hub_user_identities
             WHERE platform = $1 AND platform_user_id = $2`,
            [event.platform, event.platformUserId]
          );
          const hubUserId = identityResult.rows[0]?.hub_user_id || null;

          await query(
            `INSERT INTO activity_message_events
             (community_id, hub_user_id, platform, platform_user_id, platform_username, channel_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [event.communityId, hubUserId, event.platform, event.platformUserId, event.platformUsername, event.channelId]
          );

          await updateDailyStats(event.communityId, hubUserId, event.platformUserId, event.platformUsername, 0, 1);
          processed++;
        }
      } catch {
        failed++;
      }
    }

    res.json({ success: true, processed, failed });
  } catch (err) {
    logger.error('Error recording activity batch', { error: err.message });
    next(err);
  }
}

/**
 * Get watch time leaderboard for a community
 */
export async function getWatchTimeLeaderboard(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const period = req.query.period || 'alltime';
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Get leaderboard config
    const configResult = await query(
      `SELECT enabled_platforms, min_watch_time_minutes, display_limit
       FROM community_leaderboard_config WHERE community_id = $1`,
      [communityId]
    );

    const config = configResult.rows[0] || {
      enabled_platforms: ['twitch', 'kick', 'youtube', 'discord'],
      min_watch_time_minutes: 5,
      display_limit: 25,
    };

    const minWatchSeconds = (config.min_watch_time_minutes || 5) * 60;
    const effectiveLimit = Math.min(limit, config.display_limit || 25);

    // Build date filter
    let dateFilter = '';
    if (period === 'weekly') {
      dateFilter = `AND stat_date >= CURRENT_DATE - INTERVAL '7 days'`;
    } else if (period === 'monthly') {
      dateFilter = `AND stat_date >= CURRENT_DATE - INTERVAL '30 days'`;
    }

    // Query aggregated stats
    const result = await query(
      `SELECT
         COALESCE(asd.hub_user_id, -1) as user_id,
         COALESCE(u.username, asd.platform_username) as username,
         u.avatar_url,
         SUM(asd.watch_time_seconds) as total_watch_time
       FROM activity_stats_daily asd
       LEFT JOIN hub_users u ON u.id = asd.hub_user_id
       WHERE asd.community_id = $1 ${dateFilter}
       GROUP BY COALESCE(asd.hub_user_id, -1), COALESCE(u.username, asd.platform_username), u.avatar_url
       HAVING SUM(asd.watch_time_seconds) >= $2
       ORDER BY total_watch_time DESC
       LIMIT $3 OFFSET $4`,
      [communityId, minWatchSeconds, effectiveLimit, offset]
    );

    // Get total count for pagination
    const countResult = await query(
      `SELECT COUNT(*) as count FROM (
         SELECT COALESCE(hub_user_id, -1) as uid
         FROM activity_stats_daily
         WHERE community_id = $1 ${dateFilter}
         GROUP BY COALESCE(hub_user_id, -1), COALESCE(platform_user_id, '')
         HAVING SUM(watch_time_seconds) >= $2
       ) t`,
      [communityId, minWatchSeconds]
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const leaderboard = result.rows.map((row, index) => ({
      rank: offset + index + 1,
      userId: row.user_id > 0 ? row.user_id : null,
      username: row.username,
      avatarUrl: row.avatar_url,
      watchTimeSeconds: parseInt(row.total_watch_time, 10),
      watchTimeFormatted: formatDuration(parseInt(row.total_watch_time, 10)),
    }));

    res.json({
      success: true,
      leaderboard,
      pagination: {
        offset,
        limit: effectiveLimit,
        total,
        hasMore: offset + leaderboard.length < total,
      },
      period,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get message count leaderboard for a community
 */
export async function getMessageLeaderboard(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const period = req.query.period || 'alltime';
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Get leaderboard config
    const configResult = await query(
      `SELECT enabled_platforms, min_message_count, display_limit
       FROM community_leaderboard_config WHERE community_id = $1`,
      [communityId]
    );

    const config = configResult.rows[0] || {
      enabled_platforms: ['twitch', 'kick', 'youtube', 'discord'],
      min_message_count: 10,
      display_limit: 25,
    };

    const minMessages = config.min_message_count || 10;
    const effectiveLimit = Math.min(limit, config.display_limit || 25);

    // Build date filter
    let dateFilter = '';
    if (period === 'weekly') {
      dateFilter = `AND stat_date >= CURRENT_DATE - INTERVAL '7 days'`;
    } else if (period === 'monthly') {
      dateFilter = `AND stat_date >= CURRENT_DATE - INTERVAL '30 days'`;
    }

    // Query aggregated stats
    const result = await query(
      `SELECT
         COALESCE(asd.hub_user_id, -1) as user_id,
         COALESCE(u.username, asd.platform_username) as username,
         u.avatar_url,
         SUM(asd.message_count) as total_messages
       FROM activity_stats_daily asd
       LEFT JOIN hub_users u ON u.id = asd.hub_user_id
       WHERE asd.community_id = $1 ${dateFilter}
       GROUP BY COALESCE(asd.hub_user_id, -1), COALESCE(u.username, asd.platform_username), u.avatar_url
       HAVING SUM(asd.message_count) >= $2
       ORDER BY total_messages DESC
       LIMIT $3 OFFSET $4`,
      [communityId, minMessages, effectiveLimit, offset]
    );

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as count FROM (
         SELECT COALESCE(hub_user_id, -1) as uid
         FROM activity_stats_daily
         WHERE community_id = $1 ${dateFilter}
         GROUP BY COALESCE(hub_user_id, -1), COALESCE(platform_user_id, '')
         HAVING SUM(message_count) >= $2
       ) t`,
      [communityId, minMessages]
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const leaderboard = result.rows.map((row, index) => ({
      rank: offset + index + 1,
      userId: row.user_id > 0 ? row.user_id : null,
      username: row.username,
      avatarUrl: row.avatar_url,
      messageCount: parseInt(row.total_messages, 10),
    }));

    res.json({
      success: true,
      leaderboard,
      pagination: {
        offset,
        limit: effectiveLimit,
        total,
        hasMore: offset + leaderboard.length < total,
      },
      period,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get current user's activity stats in a community
 */
export async function getMyActivityStats(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const userId = req.user.id;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Get all-time stats
    const allTimeResult = await query(
      `SELECT
         SUM(watch_time_seconds) as total_watch_time,
         SUM(message_count) as total_messages
       FROM activity_stats_daily
       WHERE community_id = $1 AND hub_user_id = $2`,
      [communityId, userId]
    );

    // Get weekly stats
    const weeklyResult = await query(
      `SELECT
         SUM(watch_time_seconds) as total_watch_time,
         SUM(message_count) as total_messages
       FROM activity_stats_daily
       WHERE community_id = $1 AND hub_user_id = $2
       AND stat_date >= CURRENT_DATE - INTERVAL '7 days'`,
      [communityId, userId]
    );

    // Get monthly stats
    const monthlyResult = await query(
      `SELECT
         SUM(watch_time_seconds) as total_watch_time,
         SUM(message_count) as total_messages
       FROM activity_stats_daily
       WHERE community_id = $1 AND hub_user_id = $2
       AND stat_date >= CURRENT_DATE - INTERVAL '30 days'`,
      [communityId, userId]
    );

    // Get user's ranks
    const watchTimeRank = await getUserRank(communityId, userId, 'watch_time');
    const messageRank = await getUserRank(communityId, userId, 'messages');

    const allTime = allTimeResult.rows[0] || {};
    const weekly = weeklyResult.rows[0] || {};
    const monthly = monthlyResult.rows[0] || {};

    res.json({
      success: true,
      stats: {
        allTime: {
          watchTimeSeconds: parseInt(allTime.total_watch_time || 0, 10),
          watchTimeFormatted: formatDuration(parseInt(allTime.total_watch_time || 0, 10)),
          messageCount: parseInt(allTime.total_messages || 0, 10),
        },
        weekly: {
          watchTimeSeconds: parseInt(weekly.total_watch_time || 0, 10),
          watchTimeFormatted: formatDuration(parseInt(weekly.total_watch_time || 0, 10)),
          messageCount: parseInt(weekly.total_messages || 0, 10),
        },
        monthly: {
          watchTimeSeconds: parseInt(monthly.total_watch_time || 0, 10),
          watchTimeFormatted: formatDuration(parseInt(monthly.total_watch_time || 0, 10)),
          messageCount: parseInt(monthly.total_messages || 0, 10),
        },
        ranks: {
          watchTime: watchTimeRank,
          messages: messageRank,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get leaderboard configuration for a community
 */
export async function getLeaderboardConfig(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    const result = await query(
      `SELECT * FROM community_leaderboard_config WHERE community_id = $1`,
      [communityId]
    );

    if (result.rows.length === 0) {
      // Return defaults
      return res.json({
        success: true,
        config: {
          enabledPlatforms: ['twitch', 'kick', 'youtube', 'discord'],
          watchTimeEnabled: true,
          messagesEnabled: true,
          publicLeaderboard: true,
          minWatchTimeMinutes: 5,
          minMessageCount: 10,
          displayLimit: 25,
        },
      });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      config: {
        enabledPlatforms: row.enabled_platforms || ['twitch', 'kick', 'youtube', 'discord'],
        watchTimeEnabled: row.watch_time_enabled,
        messagesEnabled: row.messages_enabled,
        publicLeaderboard: row.public_leaderboard,
        minWatchTimeMinutes: row.min_watch_time_minutes,
        minMessageCount: row.min_message_count,
        displayLimit: row.display_limit,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update leaderboard configuration for a community
 */
export async function updateLeaderboardConfig(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const {
      enabledPlatforms,
      watchTimeEnabled,
      messagesEnabled,
      publicLeaderboard,
      minWatchTimeMinutes,
      minMessageCount,
      displayLimit,
    } = req.body;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Validate enabled platforms
    const validPlatforms = ['twitch', 'kick', 'youtube', 'discord', 'slack', 'hub'];
    if (enabledPlatforms) {
      for (const p of enabledPlatforms) {
        if (!validPlatforms.includes(p)) {
          return next(errors.badRequest(`Invalid platform: ${p}`));
        }
      }
    }

    await query(
      `INSERT INTO community_leaderboard_config
       (community_id, enabled_platforms, watch_time_enabled, messages_enabled,
        public_leaderboard, min_watch_time_minutes, min_message_count, display_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (community_id) DO UPDATE SET
         enabled_platforms = COALESCE($2, community_leaderboard_config.enabled_platforms),
         watch_time_enabled = COALESCE($3, community_leaderboard_config.watch_time_enabled),
         messages_enabled = COALESCE($4, community_leaderboard_config.messages_enabled),
         public_leaderboard = COALESCE($5, community_leaderboard_config.public_leaderboard),
         min_watch_time_minutes = COALESCE($6, community_leaderboard_config.min_watch_time_minutes),
         min_message_count = COALESCE($7, community_leaderboard_config.min_message_count),
         display_limit = COALESCE($8, community_leaderboard_config.display_limit),
         updated_at = NOW()`,
      [
        communityId,
        enabledPlatforms ? JSON.stringify(enabledPlatforms) : null,
        watchTimeEnabled,
        messagesEnabled,
        publicLeaderboard,
        minWatchTimeMinutes,
        minMessageCount,
        displayLimit,
      ]
    );

    logger.audit('Leaderboard config updated', {
      userId: req.user.id,
      communityId,
      changes: req.body,
    });

    res.json({ success: true, message: 'Leaderboard configuration updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Close stale watch sessions (called by background job)
 */
export async function closeStaleWatchSessions(req, res, next) {
  try {
    const staleMinutes = parseInt(req.query.staleMinutes || '30', 10);

    const result = await query(
      `UPDATE activity_watch_sessions
       SET is_active = false,
           session_end = updated_at,
           duration_seconds = EXTRACT(EPOCH FROM (updated_at - session_start))::INTEGER
       WHERE is_active = true
       AND updated_at < NOW() - INTERVAL '${staleMinutes} minutes'
       RETURNING id, community_id, hub_user_id, platform_user_id, platform_username, duration_seconds`
    );

    // Update daily stats for closed sessions
    for (const row of result.rows) {
      await updateDailyStats(
        row.community_id,
        row.hub_user_id,
        row.platform_user_id,
        row.platform_username,
        row.duration_seconds || 0,
        0
      );
    }

    logger.info('Closed stale watch sessions', { count: result.rows.length });
    res.json({ success: true, closedSessions: result.rows.length });
  } catch (err) {
    next(err);
  }
}

// Helper functions

/**
 * Update daily stats for a user
 */
async function updateDailyStats(communityId, hubUserId, platformUserId, platformUsername, watchSeconds, messageCount) {
  try {
    await query(
      `INSERT INTO activity_stats_daily
       (community_id, hub_user_id, platform_user_id, platform_username, stat_date, watch_time_seconds, message_count)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)
       ON CONFLICT (community_id, COALESCE(hub_user_id, -1), COALESCE(platform_user_id, ''), stat_date)
       DO UPDATE SET
         watch_time_seconds = activity_stats_daily.watch_time_seconds + $5,
         message_count = activity_stats_daily.message_count + $6,
         platform_username = COALESCE($4, activity_stats_daily.platform_username),
         updated_at = NOW()`,
      [communityId, hubUserId, platformUserId, platformUsername, watchSeconds, messageCount]
    );
  } catch (err) {
    logger.error('Error updating daily stats', { error: err.message, communityId, hubUserId });
  }
}

/**
 * Get user's rank in a leaderboard
 */
async function getUserRank(communityId, userId, type) {
  try {
    const column = type === 'watch_time' ? 'watch_time_seconds' : 'message_count';
    const result = await query(
      `SELECT rank FROM (
         SELECT hub_user_id, RANK() OVER (ORDER BY SUM(${column}) DESC) as rank
         FROM activity_stats_daily
         WHERE community_id = $1 AND hub_user_id IS NOT NULL
         GROUP BY hub_user_id
       ) t WHERE hub_user_id = $2`,
      [communityId, userId]
    );
    return result.rows[0]?.rank || null;
  } catch {
    return null;
  }
}

/**
 * Format duration in seconds to human readable string
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
