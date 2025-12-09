/**
 * Community Profile Controller
 * Handles community profile management including about section, social links, and images.
 */
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import {
  uploadFile,
  deleteFile,
  isAllowedImageType,
  MAX_FILE_SIZES,
} from '../services/storageService.js';

// Valid community visibility options
const VALID_VISIBILITIES = ['public', 'registered', 'members_only'];

/**
 * Get community profile (public endpoint with visibility check)
 * GET /api/v1/public/communities/:id/profile
 */
export async function getCommunityProfile(req, res, next) {
  try {
    const { id } = req.params;
    const viewerId = req.user?.userId;

    const community = await getCommunityById(id);

    if (!community) {
      return next(errors.notFound('Community not found'));
    }

    // Check visibility permissions
    const canView = await canViewCommunity(community, viewerId);

    if (!canView) {
      return res.json({
        success: true,
        community: {
          id: community.id,
          name: community.name,
          displayName: community.displayName,
          logoUrl: community.logoUrl,
          visibility: community.visibility,
          restricted: true,
        },
      });
    }

    res.json({
      success: true,
      community,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update community profile (admin only)
 * PUT /api/v1/admin/:communityId/profile
 */
export async function updateCommunityProfile(req, res, next) {
  try {
    const communityId = req.params.communityId || req.params.id;

    // Verify admin access (middleware should have already checked this)
    if (!req.communityRole || !['community-owner', 'community-admin'].includes(req.communityRole)) {
      return next(errors.forbidden('Admin access required'));
    }

    const {
      displayName,
      description,
      aboutExtended,
      socialLinks,
      websiteUrl,
      discordInviteUrl,
      visibility,
    } = req.body;

    // Validate visibility
    if (visibility && !VALID_VISIBILITIES.includes(visibility)) {
      return next(errors.badRequest('Invalid visibility setting'));
    }

    // Validate URLs
    if (websiteUrl && !isValidUrl(websiteUrl)) {
      return next(errors.badRequest('Invalid website URL'));
    }

    if (discordInviteUrl && !isValidDiscordInvite(discordInviteUrl)) {
      return next(errors.badRequest('Invalid Discord invite URL'));
    }

    // Update community
    const result = await query(
      `UPDATE communities SET
        display_name = COALESCE($1, display_name),
        description = COALESCE($2, description),
        about_extended = COALESCE($3, about_extended),
        social_links = COALESCE($4, social_links),
        website_url = COALESCE($5, website_url),
        discord_invite_url = COALESCE($6, discord_invite_url),
        visibility = COALESCE($7, visibility),
        updated_at = NOW()
      WHERE id = $8
      RETURNING *`,
      [
        displayName || null,
        description || null,
        aboutExtended || null,
        socialLinks ? JSON.stringify(socialLinks) : null,
        websiteUrl || null,
        discordInviteUrl || null,
        visibility || null,
        communityId,
      ]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    logger.audit('Community profile updated', {
      communityId,
      userId: req.user.userId,
      username: req.user.username,
    });

    res.json({
      success: true,
      community: formatCommunity(result.rows[0]),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Upload community logo
 * POST /api/v1/admin/:communityId/logo
 */
export async function uploadCommunityLogo(req, res, next) {
  try {
    const communityId = req.params.communityId || req.params.id;

    if (!req.file) {
      return next(errors.badRequest('No file uploaded'));
    }

    // Validate file type
    if (!isAllowedImageType(req.file.mimetype)) {
      return next(errors.badRequest('Invalid file type. Allowed: JPEG, PNG, GIF, WebP'));
    }

    // Validate file size
    if (req.file.size > MAX_FILE_SIZES.logo) {
      return next(errors.badRequest('File too large. Maximum size: 5MB'));
    }

    // Get current logo to delete
    const current = await query(
      `SELECT config FROM communities WHERE id = $1`,
      [communityId]
    );

    if (current.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const currentConfig = current.rows[0].config || {};
    if (currentConfig.logo_url) {
      await deleteFile(currentConfig.logo_url);
    }

    // Upload new logo
    const { url: logoUrl } = await uploadFile(
      req.file.buffer,
      'community-logos',
      req.file.originalname,
      req.file.mimetype
    );

    // Update community config
    await query(
      `UPDATE communities SET
        config = jsonb_set(COALESCE(config, '{}'), '{logo_url}', $1::jsonb),
        updated_at = NOW()
      WHERE id = $2`,
      [JSON.stringify(logoUrl), communityId]
    );

    logger.audit('Community logo uploaded', {
      communityId,
      userId: req.user.userId,
      logoUrl,
    });

    res.json({
      success: true,
      logoUrl,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete community logo
 * DELETE /api/v1/admin/:communityId/logo
 */
export async function deleteCommunityLogo(req, res, next) {
  try {
    const communityId = req.params.communityId || req.params.id;

    // Get current logo
    const current = await query(
      `SELECT config FROM communities WHERE id = $1`,
      [communityId]
    );

    if (current.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const currentConfig = current.rows[0].config || {};
    if (currentConfig.logo_url) {
      await deleteFile(currentConfig.logo_url);
    }

    // Remove logo_url from config
    await query(
      `UPDATE communities SET
        config = config - 'logo_url',
        updated_at = NOW()
      WHERE id = $1`,
      [communityId]
    );

    logger.audit('Community logo deleted', {
      communityId,
      userId: req.user.userId,
    });

    res.json({
      success: true,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Upload community banner
 * POST /api/v1/admin/:communityId/banner
 */
export async function uploadCommunityBanner(req, res, next) {
  try {
    const communityId = req.params.communityId || req.params.id;

    if (!req.file) {
      return next(errors.badRequest('No file uploaded'));
    }

    // Validate file type
    if (!isAllowedImageType(req.file.mimetype)) {
      return next(errors.badRequest('Invalid file type. Allowed: JPEG, PNG, GIF, WebP'));
    }

    // Validate file size
    if (req.file.size > MAX_FILE_SIZES.banner) {
      return next(errors.badRequest('File too large. Maximum size: 10MB'));
    }

    // Get current banner to delete
    const current = await query(
      `SELECT config FROM communities WHERE id = $1`,
      [communityId]
    );

    if (current.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const currentConfig = current.rows[0].config || {};
    if (currentConfig.banner_url) {
      await deleteFile(currentConfig.banner_url);
    }

    // Upload new banner
    const { url: bannerUrl } = await uploadFile(
      req.file.buffer,
      'community-banners',
      req.file.originalname,
      req.file.mimetype
    );

    // Update community config
    await query(
      `UPDATE communities SET
        config = jsonb_set(COALESCE(config, '{}'), '{banner_url}', $1::jsonb),
        updated_at = NOW()
      WHERE id = $2`,
      [JSON.stringify(bannerUrl), communityId]
    );

    logger.audit('Community banner uploaded', {
      communityId,
      userId: req.user.userId,
      bannerUrl,
    });

    res.json({
      success: true,
      bannerUrl,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete community banner
 * DELETE /api/v1/admin/:communityId/banner
 */
export async function deleteCommunityBanner(req, res, next) {
  try {
    const communityId = req.params.communityId || req.params.id;

    // Get current banner
    const current = await query(
      `SELECT config FROM communities WHERE id = $1`,
      [communityId]
    );

    if (current.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const currentConfig = current.rows[0].config || {};
    if (currentConfig.banner_url) {
      await deleteFile(currentConfig.banner_url);
    }

    // Remove banner_url from config
    await query(
      `UPDATE communities SET
        config = config - 'banner_url',
        updated_at = NOW()
      WHERE id = $1`,
      [communityId]
    );

    logger.audit('Community banner deleted', {
      communityId,
      userId: req.user.userId,
    });

    res.json({
      success: true,
    });
  } catch (err) {
    next(err);
  }
}

// Helper functions

async function getCommunityById(id) {
  const result = await query(
    `SELECT
      c.id,
      c.name,
      c.display_name,
      c.description,
      c.about_extended,
      c.social_links,
      c.website_url,
      c.discord_invite_url,
      c.platform,
      c.member_count,
      c.is_public,
      c.join_mode,
      c.visibility,
      c.config,
      c.created_at,
      u.username as owner_username
    FROM communities c
    LEFT JOIN hub_users u ON c.owner_id = u.id
    WHERE c.id = $1 AND c.is_active = true AND c.deleted_at IS NULL`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return formatCommunity(result.rows[0]);
}

function formatCommunity(row) {
  if (!row) return null;

  const config = row.config || {};

  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    aboutExtended: row.about_extended,
    socialLinks: row.social_links || {},
    websiteUrl: row.website_url,
    discordInviteUrl: row.discord_invite_url,
    platform: row.platform,
    memberCount: row.member_count,
    isPublic: row.is_public,
    joinMode: row.join_mode,
    visibility: row.visibility || 'public',
    logoUrl: config.logo_url || null,
    bannerUrl: config.banner_url || null,
    ownerUsername: row.owner_username,
    createdAt: row.created_at,
  };
}

/**
 * Check if viewer can see the community profile based on visibility settings
 * - public: Anyone can view
 * - registered: Only verified logged-in users
 * - members_only: Only community members
 */
async function canViewCommunity(community, viewerId) {
  // Public communities can be viewed by anyone
  if (community.visibility === 'public') {
    return true;
  }

  // No viewer means no access for non-public
  if (!viewerId) return false;

  // Registered visibility - requires verified logged-in user
  if (community.visibility === 'registered') {
    const viewer = await query(
      `SELECT email_verified FROM hub_users WHERE id = $1`,
      [viewerId]
    );
    return viewer.rows[0]?.email_verified === true;
  }

  // Members only - must be a community member
  if (community.visibility === 'members_only') {
    const member = await query(
      `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2`,
      [community.id, viewerId]
    );
    return member.rows.length > 0;
  }

  return false;
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDiscordInvite(string) {
  if (!string) return true;
  // Discord invites can be discord.gg/xxx or discord.com/invite/xxx
  return /^https?:\/\/(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+$/.test(string);
}

export default {
  getCommunityProfile,
  updateCommunityProfile,
  uploadCommunityLogo,
  deleteCommunityLogo,
  uploadCommunityBanner,
  deleteCommunityBanner,
};
