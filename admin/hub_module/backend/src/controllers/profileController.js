/**
 * Profile Controller - User profile management
 * Handles user profile, about me, avatar upload, and visibility settings.
 */
import { query, transaction } from '../config/database.js';
import { config } from '../config/index.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import {
  uploadFile,
  deleteFile,
  isAllowedImageType,
  MAX_FILE_SIZES,
} from '../services/storageService.js';

// Valid visibility options
const VALID_VISIBILITIES = ['public', 'registered', 'shared_communities', 'community_leaders'];

/**
 * Get authenticated user's profile
 * GET /api/v1/user/profile
 */
export async function getMyProfile(req, res, next) {
  try {
    if (!req.user?.userId) {
      return next(errors.unauthorized());
    }

    const profile = await getUserProfile(req.user.userId);

    res.json({
      success: true,
      profile,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update authenticated user's profile
 * PUT /api/v1/user/profile
 */
export async function updateMyProfile(req, res, next) {
  try {
    if (!req.user?.userId) {
      return next(errors.unauthorized());
    }

    const {
      displayName,
      bio,
      location,
      locationCity,
      locationState,
      locationCountry,
      websiteUrl,
      visibility,
      showActivity,
      showCommunities,
    } = req.body;

    // Validate visibility
    if (visibility && !VALID_VISIBILITIES.includes(visibility)) {
      return next(errors.badRequest('Invalid visibility setting'));
    }

    // Validate website URL if provided
    if (websiteUrl && !isValidUrl(websiteUrl)) {
      return next(errors.badRequest('Invalid website URL'));
    }

    // Validate bio length
    if (bio && bio.length > 2000) {
      return next(errors.badRequest('Bio must be 2000 characters or less'));
    }

    // Validate location country code (ISO 3166-1 alpha-2)
    if (locationCountry && !/^[A-Z]{2}$/.test(locationCountry)) {
      return next(errors.badRequest('Invalid country code (use ISO 3166-1 alpha-2)'));
    }

    // Upsert profile (note: social_links column deprecated, linked platforms from identities)
    const result = await query(
      `INSERT INTO hub_user_profiles (
        hub_user_id, display_name, bio, location, location_city, location_state,
        location_country, website_url, visibility, show_activity, show_communities, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (hub_user_id) DO UPDATE SET
        display_name = COALESCE($2, hub_user_profiles.display_name),
        bio = COALESCE($3, hub_user_profiles.bio),
        location = COALESCE($4, hub_user_profiles.location),
        location_city = COALESCE($5, hub_user_profiles.location_city),
        location_state = COALESCE($6, hub_user_profiles.location_state),
        location_country = COALESCE($7, hub_user_profiles.location_country),
        website_url = COALESCE($8, hub_user_profiles.website_url),
        visibility = COALESCE($9, hub_user_profiles.visibility),
        show_activity = COALESCE($10, hub_user_profiles.show_activity),
        show_communities = COALESCE($11, hub_user_profiles.show_communities),
        updated_at = NOW()
      RETURNING *`,
      [
        req.user.userId,
        displayName || null,
        bio || null,
        location || null,
        locationCity || null,
        locationState || null,
        locationCountry || null,
        websiteUrl || null,
        visibility || null,
        showActivity !== undefined ? showActivity : null,
        showCommunities !== undefined ? showCommunities : null,
      ]
    );

    logger.audit('Profile updated', {
      userId: req.user.userId,
      username: req.user.username,
    });

    res.json({
      success: true,
      profile: formatProfile(result.rows[0]),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Upload avatar for authenticated user
 * POST /api/v1/user/profile/avatar
 */
export async function uploadAvatar(req, res, next) {
  try {
    if (!req.user?.userId) {
      return next(errors.unauthorized());
    }

    if (!req.file) {
      return next(errors.badRequest('No file uploaded'));
    }

    // Validate file type
    if (!isAllowedImageType(req.file.mimetype)) {
      return next(errors.badRequest('Invalid file type. Allowed: JPEG, PNG, GIF, WebP'));
    }

    // Validate file size
    if (req.file.size > MAX_FILE_SIZES.avatar) {
      return next(errors.badRequest('File too large. Maximum size: 5MB'));
    }

    // Delete old avatar if exists
    const oldAvatar = await query(
      `SELECT custom_avatar_url FROM hub_user_profiles WHERE hub_user_id = $1`,
      [req.user.userId]
    );
    if (oldAvatar.rows[0]?.custom_avatar_url) {
      await deleteFile(oldAvatar.rows[0].custom_avatar_url);
    }

    // Upload to storage service (S3 or local)
    const { url: avatarUrl } = await uploadFile(
      req.file.buffer,
      'avatars',
      req.file.originalname,
      req.file.mimetype
    );

    // Update profile with new avatar URL
    await query(
      `INSERT INTO hub_user_profiles (hub_user_id, custom_avatar_url, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (hub_user_id) DO UPDATE SET
         custom_avatar_url = $2,
         updated_at = NOW()`,
      [req.user.userId, avatarUrl]
    );

    // Also update the main hub_users avatar_url for consistency
    await query(
      `UPDATE hub_users SET avatar_url = $1, updated_at = NOW() WHERE id = $2`,
      [avatarUrl, req.user.userId]
    );

    logger.audit('Avatar uploaded', {
      userId: req.user.userId,
      username: req.user.username,
      avatarUrl,
    });

    res.json({
      success: true,
      avatarUrl,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete avatar for authenticated user
 * DELETE /api/v1/user/profile/avatar
 */
export async function deleteAvatar(req, res, next) {
  try {
    if (!req.user?.userId) {
      return next(errors.unauthorized());
    }

    // Get current avatar URL
    const result = await query(
      `SELECT custom_avatar_url FROM hub_user_profiles WHERE hub_user_id = $1`,
      [req.user.userId]
    );

    if (result.rows[0]?.custom_avatar_url) {
      // Delete via storage service
      await deleteFile(result.rows[0].custom_avatar_url);
    }

    // Clear avatar URLs
    await query(
      `UPDATE hub_user_profiles SET custom_avatar_url = NULL, updated_at = NOW()
       WHERE hub_user_id = $1`,
      [req.user.userId]
    );

    // Get platform avatar as fallback
    const platformAvatar = await query(
      `SELECT avatar_url FROM hub_user_identities
       WHERE hub_user_id = $1 AND avatar_url IS NOT NULL
       ORDER BY linked_at DESC LIMIT 1`,
      [req.user.userId]
    );

    const fallbackAvatar = platformAvatar.rows[0]?.avatar_url || null;

    // Update hub_users to use platform avatar
    await query(
      `UPDATE hub_users SET avatar_url = $1, updated_at = NOW() WHERE id = $2`,
      [fallbackAvatar, req.user.userId]
    );

    logger.audit('Avatar deleted', {
      userId: req.user.userId,
      username: req.user.username,
    });

    res.json({
      success: true,
      avatarUrl: fallbackAvatar,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get linked platforms for authenticated user
 * GET /api/v1/user/linked-platforms
 */
export async function getMyLinkedPlatforms(req, res, next) {
  try {
    if (!req.user?.userId) {
      return next(errors.unauthorized());
    }

    const linkedPlatforms = await getLinkedPlatformsForUser(req.user.userId);

    res.json({
      success: true,
      linkedPlatforms,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get public profile for a user
 * GET /api/v1/users/:userId/profile or /api/v1/public/users/:userId/profile
 */
export async function getPublicProfile(req, res, next) {
  try {
    const { userId } = req.params;
    const viewerId = req.user?.userId;

    const profile = await getUserProfile(userId);

    if (!profile) {
      return next(errors.notFound('User not found'));
    }

    // Check visibility permissions
    const canView = await canViewProfile(profile, viewerId);

    if (!canView) {
      return res.json({
        success: true,
        profile: {
          userId: parseInt(userId),
          username: profile.username,
          avatarUrl: profile.avatarUrl,
          visibility: profile.visibility,
          restricted: true,
        },
      });
    }

    // Include linked platforms for full profile view
    const linkedPlatforms = await getLinkedPlatformsForUser(userId);

    res.json({
      success: true,
      profile: {
        ...profile,
        linkedPlatforms,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get profile for a community member
 * GET /api/v1/communities/:id/members/:userId/profile
 */
export async function getMemberProfile(req, res, next) {
  try {
    const communityId = req.params.communityId || req.params.id;
    const { userId } = req.params;
    const viewerId = req.user?.userId;

    // Check if viewer is a member of the community
    const isMember = await isCommunitMember(viewerId, communityId);

    const profile = await getUserProfile(userId);

    if (!profile) {
      return next(errors.notFound('User not found'));
    }

    // Check visibility - community members can see 'community' profiles
    const canView = await canViewProfile(profile, viewerId, communityId, isMember);

    if (!canView) {
      return res.json({
        success: true,
        profile: {
          userId: parseInt(userId),
          username: profile.username,
          avatarUrl: profile.avatarUrl,
          visibility: profile.visibility,
          restricted: true,
        },
      });
    }

    res.json({
      success: true,
      profile,
    });
  } catch (err) {
    next(err);
  }
}

// Helper functions

async function getUserProfile(userId) {
  const result = await query(
    `SELECT
      u.id as user_id,
      u.username,
      u.avatar_url,
      u.email_verified,
      u.created_at as member_since,
      p.display_name,
      p.bio,
      p.location,
      p.location_city,
      p.location_state,
      p.location_country,
      p.website_url,
      p.custom_avatar_url,
      p.banner_url,
      p.visibility,
      p.show_activity,
      p.show_communities
    FROM hub_users u
    LEFT JOIN hub_user_profiles p ON u.id = p.hub_user_id
    WHERE u.id = $1 AND u.is_active = true`,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return formatProfile(result.rows[0]);
}

async function getLinkedPlatformsForUser(userId) {
  const result = await query(
    `SELECT platform, platform_username, avatar_url
     FROM hub_user_identities
     WHERE hub_user_id = $1
     ORDER BY linked_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    platform: row.platform,
    username: row.platform_username,
    avatarUrl: row.avatar_url,
  }));
}

function formatProfile(row) {
  if (!row) return null;

  return {
    userId: row.user_id || row.hub_user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.custom_avatar_url || row.avatar_url,
    bannerUrl: row.banner_url,
    bio: row.bio,
    location: row.location,
    locationCity: row.location_city,
    locationState: row.location_state,
    locationCountry: row.location_country,
    websiteUrl: row.website_url,
    visibility: row.visibility || 'shared_communities',
    showActivity: row.show_activity !== false,
    showCommunities: row.show_communities !== false,
    memberSince: row.member_since || row.created_at,
  };
}

/**
 * Check if viewer can see the profile based on visibility settings
 * Visibility levels:
 * - public: Anyone can view
 * - registered: Only verified (email_verified=true) logged-in users
 * - shared_communities: Only users who share at least one community
 * - community_leaders: Only admins/mods of communities the user belongs to
 */
async function canViewProfile(profile, viewerId, communityId = null, isMember = false) {
  // Owner can always view their own profile
  if (viewerId && profile.userId === parseInt(viewerId)) {
    return true;
  }

  // Public profiles can be viewed by anyone
  if (profile.visibility === 'public') {
    return true;
  }

  // Registered visibility - requires verified logged-in user
  if (profile.visibility === 'registered') {
    if (!viewerId) return false;

    // Check if viewer is email verified
    const viewer = await query(
      `SELECT email_verified FROM hub_users WHERE id = $1`,
      [viewerId]
    );

    return viewer.rows[0]?.email_verified === true;
  }

  // Shared communities visibility - requires shared community membership
  if (profile.visibility === 'shared_communities' || profile.visibility === 'community') {
    if (!viewerId) return false;

    // If we already know they share this community
    if (isMember) return true;

    // Check for any shared community
    const shared = await query(
      `SELECT 1 FROM community_members cm1
       JOIN community_members cm2 ON cm1.community_id = cm2.community_id
       WHERE cm1.user_id = $1 AND cm2.user_id = $2
       LIMIT 1`,
      [viewerId, profile.userId]
    );

    return shared.rows.length > 0;
  }

  // Community leaders visibility - requires admin/mod role in user's communities
  if (profile.visibility === 'community_leaders' || profile.visibility === 'admin_only') {
    if (!viewerId) return false;

    // Viewer must be admin/mod of a community the profile user belongs to
    const isLeader = await query(
      `SELECT 1 FROM community_members cm1
       JOIN community_members cm2 ON cm1.community_id = cm2.community_id
       WHERE cm1.user_id = $1 AND cm2.user_id = $2
         AND cm1.role IN ('community-owner', 'community-admin', 'moderator')
       LIMIT 1`,
      [viewerId, profile.userId]
    );

    return isLeader.rows.length > 0;
  }

  return false;
}

async function isCommunitMember(userId, communityId) {
  if (!userId) return false;

  const result = await query(
    `SELECT 1 FROM community_members WHERE user_id = $1 AND community_id = $2`,
    [userId, communityId]
  );

  return result.rows.length > 0;
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
