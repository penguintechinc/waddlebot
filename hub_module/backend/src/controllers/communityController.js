/**
 * Community Controller - Authenticated member features
 */
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Get user's communities
 */
export async function getMyCommunities(req, res, next) {
  try {
    const result = await query(
      `SELECT c.id, c.name, c.display_name, c.description, c.logo_url,
              c.primary_platform, c.member_count, cm.role, cm.joined_at
       FROM community_members cm
       JOIN communities c ON c.id = cm.community_id
       WHERE cm.user_id = $1 AND cm.is_active = true AND c.is_active = true
       ORDER BY cm.joined_at DESC`,
      [req.user.id]
    );

    const communities = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      logoUrl: row.logo_url,
      primaryPlatform: row.primary_platform,
      memberCount: row.member_count || 0,
      role: row.role,
      joinedAt: row.joined_at?.toISOString(),
    }));

    res.json({ success: true, communities });
  } catch (err) {
    next(err);
  }
}

/**
 * Get community dashboard data
 */
export async function getCommunityDashboard(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Get community details
    const communityResult = await query(
      `SELECT id, name, display_name, description, logo_url, banner_url,
              primary_platform, member_count, created_at
       FROM communities
       WHERE id = $1 AND is_active = true`,
      [communityId]
    );

    if (communityResult.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const community = communityResult.rows[0];

    // Get user's membership
    const memberResult = await query(
      `SELECT role, reputation_score, joined_at
       FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, req.user.id]
    );

    if (memberResult.rows.length === 0) {
      return next(errors.forbidden('Not a member of this community'));
    }

    const membership = memberResult.rows[0];

    // Get recent activity
    const activityResult = await query(
      `SELECT id, activity_type, description, metadata, created_at
       FROM community_activity
       WHERE community_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [communityId]
    );

    // Get live streams if any
    const streamsResult = await query(
      `SELECT entity_id, channel_id, viewer_count, stream_title, game_name
       FROM coordination
       WHERE community_id = $1 AND is_live = true
       ORDER BY viewer_count DESC
       LIMIT 5`,
      [communityId]
    );

    res.json({
      success: true,
      community: {
        id: community.id,
        name: community.name,
        displayName: community.display_name || community.name,
        description: community.description,
        logoUrl: community.logo_url,
        bannerUrl: community.banner_url,
        primaryPlatform: community.primary_platform,
        memberCount: community.member_count || 0,
        createdAt: community.created_at?.toISOString(),
      },
      membership: {
        role: membership.role,
        reputationScore: membership.reputation_score || 0,
        joinedAt: membership.joined_at?.toISOString(),
      },
      recentActivity: activityResult.rows.map(row => ({
        id: row.id,
        type: row.activity_type,
        description: row.description,
        metadata: row.metadata,
        createdAt: row.created_at?.toISOString(),
      })),
      liveStreams: streamsResult.rows.map(row => ({
        entityId: row.entity_id,
        channelName: row.channel_id,
        viewerCount: row.viewer_count || 0,
        title: row.stream_title || '',
        game: row.game_name || '',
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get community leaderboard
 */
export async function getLeaderboard(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    const result = await query(
      `SELECT cm.user_id, cm.display_name, cm.reputation_score, cm.role,
              cm.platform, cm.platform_user_id
       FROM community_members cm
       WHERE cm.community_id = $1 AND cm.is_active = true
       ORDER BY cm.reputation_score DESC
       LIMIT $2`,
      [communityId, limit]
    );

    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      displayName: row.display_name,
      reputationScore: row.reputation_score || 0,
      role: row.role,
      platform: row.platform,
    }));

    res.json({ success: true, leaderboard });
  } catch (err) {
    next(err);
  }
}

/**
 * Get community activity feed
 */
export async function getActivityFeed(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    const countResult = await query(
      'SELECT COUNT(*) as count FROM community_activity WHERE community_id = $1',
      [communityId]
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const result = await query(
      `SELECT id, activity_type, user_id, user_name, description, metadata, created_at
       FROM community_activity
       WHERE community_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [communityId, limit, offset]
    );

    const activities = result.rows.map(row => ({
      id: row.id,
      type: row.activity_type,
      userId: row.user_id,
      userName: row.user_name,
      description: row.description,
      metadata: row.metadata,
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({
      success: true,
      activities,
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
 * Get community events
 */
export async function getEvents(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const status = req.query.status || 'approved';
    const upcoming = req.query.upcoming !== 'false';

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    let whereClause = 'WHERE community_id = $1 AND status = $2';
    const params = [communityId, status];

    if (upcoming) {
      whereClause += ' AND event_date >= NOW()';
    }

    const result = await query(
      `SELECT id, title, description, event_date, end_date, location,
              max_attendees, created_by, created_by_name, status
       FROM events
       ${whereClause}
       ORDER BY event_date ASC
       LIMIT 50`,
      params
    );

    const events = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      eventDate: row.event_date?.toISOString(),
      endDate: row.end_date?.toISOString(),
      location: row.location,
      maxAttendees: row.max_attendees,
      createdBy: row.created_by_name,
      status: row.status,
    }));

    res.json({ success: true, events });
  } catch (err) {
    next(err);
  }
}

/**
 * Get community memories (quotes, URLs)
 */
export async function getMemories(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const type = req.query.type; // quote, url, note
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    let whereClause = 'WHERE community_id = $1 AND is_active = true';
    const params = [communityId];

    if (type) {
      whereClause += ' AND memory_type = $2';
      params.push(type);
    }

    const result = await query(
      `SELECT id, memory_type, title, content, url, author, tags, usage_count, created_at
       FROM memories
       ${whereClause}
       ORDER BY usage_count DESC, created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    const memories = result.rows.map(row => ({
      id: row.id,
      type: row.memory_type,
      title: row.title,
      content: row.content,
      url: row.url,
      author: row.author,
      tags: row.tags,
      usageCount: row.usage_count || 0,
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({ success: true, memories });
  } catch (err) {
    next(err);
  }
}

/**
 * Get installed modules for community
 */
export async function getInstalledModules(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    const result = await query(
      `SELECT mi.id, mi.module_id, m.name, m.display_name, m.description,
              m.category, m.icon_url, mi.is_enabled, mi.config, mi.installed_at
       FROM module_installations mi
       JOIN modules m ON m.id = mi.module_id
       WHERE mi.community_id = $1
       ORDER BY mi.installed_at DESC`,
      [communityId]
    );

    const modules = result.rows.map(row => ({
      installationId: row.id,
      moduleId: row.module_id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      category: row.category,
      iconUrl: row.icon_url,
      isEnabled: row.is_enabled,
      config: row.config,
      installedAt: row.installed_at?.toISOString(),
    }));

    res.json({ success: true, modules });
  } catch (err) {
    next(err);
  }
}

/**
 * Update user profile in community
 */
export async function updateProfile(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const { displayName, bio, socialLinks } = req.body;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Update community member profile
    await query(
      `UPDATE community_members
       SET display_name = COALESCE($1, display_name),
           bio = COALESCE($2, bio),
           social_links = COALESCE($3, social_links),
           updated_at = NOW()
       WHERE community_id = $4 AND user_id = $5`,
      [displayName, bio, socialLinks ? JSON.stringify(socialLinks) : null, communityId, req.user.id]
    );

    logger.audit('Profile updated', {
      userId: req.user.id,
      communityId,
      fields: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Leave community
 */
export async function leaveCommunity(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Check if user is owner
    const memberResult = await query(
      `SELECT role FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, req.user.id]
    );

    if (memberResult.rows.length === 0) {
      return next(errors.badRequest('Not a member of this community'));
    }

    if (memberResult.rows[0].role === 'community-owner') {
      return next(errors.badRequest('Owners cannot leave. Transfer ownership first.'));
    }

    // Deactivate membership
    await query(
      `UPDATE community_members
       SET is_active = false, left_at = NOW()
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, req.user.id]
    );

    // Update member count
    await query(
      `UPDATE communities
       SET member_count = member_count - 1
       WHERE id = $1`,
      [communityId]
    );

    logger.audit('User left community', {
      userId: req.user.id,
      communityId,
    });

    res.json({ success: true, message: 'Left community successfully' });
  } catch (err) {
    next(err);
  }
}
