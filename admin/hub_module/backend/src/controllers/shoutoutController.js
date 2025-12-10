import db from '../utils/db.js';
import * as errors from '../utils/errors.js';

const SHOUTOUT_MODULE_URL = process.env.SHOUTOUT_MODULE_URL || 'http://shoutout-interaction:8015';

/**
 * Get shoutout configuration for a community
 */
export async function getShoutoutConfig(req, res, next) {
  try {
    const { communityId } = req.params;

    // Verify community exists and user has access
    const community = await db.query(
      'SELECT id, community_type FROM communities WHERE id = $1',
      [communityId]
    );

    if (community.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    // Check if shoutouts are available for this community type
    const validTypes = ['creator', 'gaming'];
    if (!validTypes.includes(community.rows[0].community_type)) {
      return next(errors.forbidden('Shoutouts are only available for Creator and Gaming communities'));
    }

    // Get config from database
    const result = await db.query(
      `SELECT
        so_enabled as "soEnabled",
        so_permission as "soPermission",
        vso_enabled as "vsoEnabled",
        vso_permission as "vsoPermission",
        auto_shoutout_mode as "autoShoutoutMode",
        trigger_first_message as "triggerFirstMessage",
        trigger_raid_host as "triggerRaidHost",
        widget_position as "widgetPosition",
        widget_duration_seconds as "widgetDurationSeconds",
        cooldown_minutes as "cooldownMinutes"
      FROM shoutout_config
      WHERE community_id = $1`,
      [communityId]
    );

    res.json({
      success: true,
      config: result.rows[0] || null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update shoutout configuration for a community
 */
export async function updateShoutoutConfig(req, res, next) {
  try {
    const { communityId } = req.params;
    const {
      soEnabled,
      soPermission,
      vsoEnabled,
      vsoPermission,
      autoShoutoutMode,
      triggerFirstMessage,
      triggerRaidHost,
      widgetPosition,
      widgetDurationSeconds,
      cooldownMinutes,
    } = req.body;

    // Verify community exists and user has access
    const community = await db.query(
      'SELECT id, community_type FROM communities WHERE id = $1',
      [communityId]
    );

    if (community.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    // Check if shoutouts are available for this community type
    const validTypes = ['creator', 'gaming'];
    if (!validTypes.includes(community.rows[0].community_type)) {
      return next(errors.forbidden('Shoutouts are only available for Creator and Gaming communities'));
    }

    // Validate permission values
    const validPermissions = ['admin_only', 'mod', 'vip', 'subscriber', 'everyone'];
    if (soPermission && !validPermissions.includes(soPermission)) {
      return next(errors.badRequest('Invalid permission value for so_permission'));
    }
    if (vsoPermission && !validPermissions.includes(vsoPermission)) {
      return next(errors.badRequest('Invalid permission value for vso_permission'));
    }

    // Validate auto shoutout mode
    const validModes = ['disabled', 'all_creators', 'list_only', 'role_based'];
    if (autoShoutoutMode && !validModes.includes(autoShoutoutMode)) {
      return next(errors.badRequest('Invalid auto_shoutout_mode value'));
    }

    // Validate widget position
    const validPositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    if (widgetPosition && !validPositions.includes(widgetPosition)) {
      return next(errors.badRequest('Invalid widget_position value'));
    }

    // Upsert config
    const result = await db.query(
      `INSERT INTO shoutout_config (
        community_id, so_enabled, so_permission, vso_enabled, vso_permission,
        auto_shoutout_mode, trigger_first_message, trigger_raid_host,
        widget_position, widget_duration_seconds, cooldown_minutes, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (community_id) DO UPDATE SET
        so_enabled = COALESCE($2, shoutout_config.so_enabled),
        so_permission = COALESCE($3, shoutout_config.so_permission),
        vso_enabled = COALESCE($4, shoutout_config.vso_enabled),
        vso_permission = COALESCE($5, shoutout_config.vso_permission),
        auto_shoutout_mode = COALESCE($6, shoutout_config.auto_shoutout_mode),
        trigger_first_message = COALESCE($7, shoutout_config.trigger_first_message),
        trigger_raid_host = COALESCE($8, shoutout_config.trigger_raid_host),
        widget_position = COALESCE($9, shoutout_config.widget_position),
        widget_duration_seconds = COALESCE($10, shoutout_config.widget_duration_seconds),
        cooldown_minutes = COALESCE($11, shoutout_config.cooldown_minutes),
        updated_at = NOW()
      RETURNING
        so_enabled as "soEnabled",
        so_permission as "soPermission",
        vso_enabled as "vsoEnabled",
        vso_permission as "vsoPermission",
        auto_shoutout_mode as "autoShoutoutMode",
        trigger_first_message as "triggerFirstMessage",
        trigger_raid_host as "triggerRaidHost",
        widget_position as "widgetPosition",
        widget_duration_seconds as "widgetDurationSeconds",
        cooldown_minutes as "cooldownMinutes"`,
      [
        communityId,
        soEnabled,
        soPermission,
        vsoEnabled,
        vsoPermission,
        autoShoutoutMode,
        triggerFirstMessage,
        triggerRaidHost,
        widgetPosition,
        widgetDurationSeconds,
        cooldownMinutes,
      ]
    );

    res.json({
      success: true,
      config: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get auto-shoutout creators list for a community
 */
export async function getShoutoutCreators(req, res, next) {
  try {
    const { communityId } = req.params;

    const result = await db.query(
      `SELECT
        id,
        platform,
        platform_user_id as "platformUserId",
        platform_username as "platformUsername",
        custom_trigger as "customTrigger",
        added_by as "addedBy",
        created_at as "createdAt"
      FROM auto_shoutout_creators
      WHERE community_id = $1
      ORDER BY created_at DESC`,
      [communityId]
    );

    res.json({
      success: true,
      creators: result.rows,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Add a creator to the auto-shoutout list
 */
export async function addShoutoutCreator(req, res, next) {
  try {
    const { communityId } = req.params;
    const { platform, username } = req.body;

    if (!platform || !username) {
      return next(errors.badRequest('Platform and username are required'));
    }

    // Validate platform
    const validPlatforms = ['twitch', 'youtube'];
    if (!validPlatforms.includes(platform)) {
      return next(errors.badRequest('Invalid platform. Must be twitch or youtube'));
    }

    // For now, use username as user_id (can be resolved later via API)
    const platformUserId = username.toLowerCase();

    const result = await db.query(
      `INSERT INTO auto_shoutout_creators (
        community_id, platform, platform_user_id, platform_username, added_by
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (community_id, platform, platform_user_id) DO NOTHING
      RETURNING
        id,
        platform,
        platform_user_id as "platformUserId",
        platform_username as "platformUsername",
        created_at as "createdAt"`,
      [communityId, platform, platformUserId, username, req.user?.id]
    );

    if (result.rows.length === 0) {
      return next(errors.conflict('Creator already exists in the list'));
    }

    res.json({
      success: true,
      creator: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Remove a creator from the auto-shoutout list
 */
export async function removeShoutoutCreator(req, res, next) {
  try {
    const { communityId, creatorId } = req.params;

    const result = await db.query(
      `DELETE FROM auto_shoutout_creators
       WHERE id = $1 AND community_id = $2
       RETURNING id`,
      [creatorId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Creator not found'));
    }

    res.json({
      success: true,
      message: 'Creator removed from auto-shoutout list',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get video shoutout history for a community
 */
export async function getShoutoutHistory(req, res, next) {
  try {
    const { communityId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT
        id,
        target_platform as "targetPlatform",
        target_user_id as "targetUserId",
        target_username as "targetUsername",
        video_platform as "videoPlatform",
        video_id as "videoId",
        video_title as "videoTitle",
        video_thumbnail_url as "videoThumbnailUrl",
        trigger_type as "triggerType",
        triggered_by_user_id as "triggeredByUserId",
        triggered_by_username as "triggeredByUsername",
        created_at as "createdAt"
      FROM video_shoutout_history
      WHERE community_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
      [communityId, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) FROM video_shoutout_history WHERE community_id = $1',
      [communityId]
    );

    res.json({
      success: true,
      history: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    next(err);
  }
}
