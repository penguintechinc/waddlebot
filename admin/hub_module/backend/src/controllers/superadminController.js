/**
 * Super Admin Controller - Global admin features for managing all communities
 */
import { query, transaction } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * List all communities with pagination and filtering
 */
export async function listCommunities(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const platform = req.query.platform;
    const isActive = req.query.isActive;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (platform) {
      whereClause += ` AND platform = $${paramIndex}`;
      params.push(platform);
      paramIndex++;
    }

    if (isActive !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`;
      params.push(isActive === 'true');
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) as count FROM communities ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const result = await query(
      `SELECT id, name, display_name, description, platform, platform_server_id,
              owner_id, owner_name, member_count, is_active, is_public, created_at, updated_at
       FROM communities
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    const communities = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      platform: row.platform,
      platformServerId: row.platform_server_id,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      memberCount: row.member_count || 0,
      isActive: row.is_active,
      isPublic: row.is_public,
      createdAt: row.created_at?.toISOString(),
      updatedAt: row.updated_at?.toISOString(),
    }));

    res.json({
      success: true,
      communities,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get single community details
 */
export async function getCommunity(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);

    const result = await query(
      `SELECT id, name, display_name, description, platform, platform_server_id,
              owner_id, owner_name, member_count, is_active, is_public, config,
              created_at, updated_at
       FROM communities WHERE id = $1`,
      [communityId]
    );

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
        platform: row.platform,
        platformServerId: row.platform_server_id,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        memberCount: row.member_count || 0,
        isActive: row.is_active,
        isPublic: row.is_public,
        config: row.config,
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Create a new community
 */
export async function createCommunity(req, res, next) {
  try {
    const { name, displayName, description, platform, platformServerId, ownerId, ownerName, isPublic } = req.body;

    if (!name || !platform) {
      return next(errors.badRequest('Name and platform are required'));
    }

    // Check if community name already exists
    const existingResult = await query(
      'SELECT id FROM communities WHERE name = $1',
      [name.toLowerCase().replace(/\s+/g, '-')]
    );

    if (existingResult.rows.length > 0) {
      return next(errors.conflict('Community name already exists'));
    }

    const result = await query(
      `INSERT INTO communities
       (name, display_name, description, platform, platform_server_id, owner_id, owner_name, is_public, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, display_name, platform, created_at`,
      [
        name.toLowerCase().replace(/\s+/g, '-'),
        displayName || name,
        description || '',
        platform,
        platformServerId || null,
        ownerId || null,
        ownerName || null,
        isPublic !== false,
        req.user.platformUserId,
      ]
    );

    logger.audit('Community created', {
      adminId: req.user.platformUserId,
      communityId: result.rows[0].id,
      name: result.rows[0].name,
    });

    res.status(201).json({
      success: true,
      community: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        displayName: result.rows[0].display_name,
        platform: result.rows[0].platform,
        createdAt: result.rows[0].created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update community details
 */
export async function updateCommunity(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const { displayName, description, ownerId, ownerName, isActive, isPublic, platform, platformServerId } = req.body;

    // Check community exists
    const existingResult = await query(
      'SELECT id FROM communities WHERE id = $1',
      [communityId]
    );

    if (existingResult.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const updates = [];
    const params = [communityId];
    let paramIndex = 2;

    if (displayName !== undefined) {
      updates.push(`display_name = $${paramIndex++}`);
      params.push(displayName);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }
    if (ownerId !== undefined) {
      updates.push(`owner_id = $${paramIndex++}`);
      params.push(ownerId);
    }
    if (ownerName !== undefined) {
      updates.push(`owner_name = $${paramIndex++}`);
      params.push(ownerName);
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(isActive);
    }
    if (isPublic !== undefined) {
      updates.push(`is_public = $${paramIndex++}`);
      params.push(isPublic);
    }
    if (platform !== undefined) {
      updates.push(`platform = $${paramIndex++}`);
      params.push(platform);
    }
    if (platformServerId !== undefined) {
      updates.push(`platform_server_id = $${paramIndex++}`);
      params.push(platformServerId);
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    updates.push('updated_at = NOW()');

    await query(
      `UPDATE communities SET ${updates.join(', ')} WHERE id = $1`,
      params
    );

    logger.audit('Community updated', {
      adminId: req.user.platformUserId,
      communityId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Community updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete (deactivate) a community
 */
export async function deleteCommunity(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);

    const result = await query(
      `UPDATE communities SET is_active = false, deleted_at = NOW(), deleted_by = $1
       WHERE id = $2 RETURNING name`,
      [req.user.platformUserId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    logger.audit('Community deleted', {
      adminId: req.user.platformUserId,
      communityId,
      name: result.rows[0].name,
    });

    res.json({ success: true, message: 'Community deleted' });
  } catch (err) {
    next(err);
  }
}

/**
 * Reassign community ownership
 */
export async function reassignOwner(req, res, next) {
  try {
    const communityId = parseInt(req.params.id, 10);
    const { newOwnerId, newOwnerName } = req.body;

    if (!newOwnerName) {
      return next(errors.badRequest('New owner name is required'));
    }

    // Get current owner info for audit
    const currentResult = await query(
      'SELECT owner_id, owner_name FROM communities WHERE id = $1',
      [communityId]
    );

    if (currentResult.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const previousOwner = currentResult.rows[0];

    // Update owner
    await query(
      `UPDATE communities
       SET owner_id = $1, owner_name = $2, updated_at = NOW()
       WHERE id = $3`,
      [newOwnerId || null, newOwnerName, communityId]
    );

    logger.audit('Community ownership reassigned', {
      adminId: req.user.platformUserId,
      communityId,
      previousOwnerId: previousOwner.owner_id,
      previousOwnerName: previousOwner.owner_name,
      newOwnerId,
      newOwnerName,
    });

    res.json({ success: true, message: 'Ownership reassigned' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get dashboard stats for super admin
 */
export async function getDashboardStats(req, res, next) {
  try {
    const statsResult = await query(`
      SELECT
        COUNT(*) as total_communities,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active_communities,
        COUNT(CASE WHEN platform = 'discord' THEN 1 END) as discord_communities,
        COUNT(CASE WHEN platform = 'twitch' THEN 1 END) as twitch_communities,
        COUNT(CASE WHEN platform = 'slack' THEN 1 END) as slack_communities,
        COALESCE(SUM(member_count), 0) as total_members
      FROM communities
    `);

    const adminResult = await query(`
      SELECT COUNT(*) as admin_count FROM hub_admins WHERE is_active = true
    `);

    const recentResult = await query(`
      SELECT id, name, display_name, platform, created_at
      FROM communities
      ORDER BY created_at DESC
      LIMIT 5
    `);

    res.json({
      success: true,
      stats: {
        totalCommunities: parseInt(statsResult.rows[0]?.total_communities || 0, 10),
        activeCommunities: parseInt(statsResult.rows[0]?.active_communities || 0, 10),
        platformBreakdown: {
          discord: parseInt(statsResult.rows[0]?.discord_communities || 0, 10),
          twitch: parseInt(statsResult.rows[0]?.twitch_communities || 0, 10),
          slack: parseInt(statsResult.rows[0]?.slack_communities || 0, 10),
        },
        totalMembers: parseInt(statsResult.rows[0]?.total_members || 0, 10),
        adminCount: parseInt(adminResult.rows[0]?.admin_count || 0, 10),
      },
      recentCommunities: recentResult.rows.map(row => ({
        id: row.id,
        name: row.name,
        displayName: row.display_name || row.name,
        platform: row.platform,
        createdAt: row.created_at?.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Module Registry - Super Admin Only
 */

/**
 * Get all modules (including unpublished)
 * GET /api/v1/superadmin/marketplace/modules
 */
export async function getAllModules(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const category = req.query.category;
    const isPublished = req.query.isPublished;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (isPublished !== undefined) {
      whereClause += ` AND is_published = $${paramIndex}`;
      params.push(isPublished === 'true');
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) as count FROM hub_modules ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const result = await query(
      `SELECT
        m.id, m.name, m.display_name, m.description, m.version,
        m.author, m.category, m.icon_url, m.is_published, m.is_core, m.created_at,
        COALESCE(AVG(r.rating), 0) as avg_rating,
        COUNT(DISTINCT r.id) as review_count,
        COUNT(DISTINCT i.id) as install_count
       FROM hub_modules m
       LEFT JOIN hub_module_reviews r ON r.module_id = m.id
       LEFT JOIN hub_module_installations i ON i.module_id = m.id
       ${whereClause}
       GROUP BY m.id
       ORDER BY m.is_core DESC, m.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    const modules = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      category: row.category,
      iconUrl: row.icon_url,
      isPublished: row.is_published,
      isCore: row.is_core,
      avgRating: parseFloat(row.avg_rating || 0).toFixed(1),
      reviewCount: parseInt(row.review_count || 0, 10),
      installCount: parseInt(row.install_count || 0, 10),
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({
      success: true,
      modules,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Create a new module
 * POST /api/v1/superadmin/marketplace/modules
 */
export async function createModule(req, res, next) {
  try {
    const { name, displayName, description, version, author, category, iconUrl, isCore, configSchema } = req.body;

    if (!name) {
      return next(errors.badRequest('Module name is required'));
    }

    // Check if module name already exists
    const existingResult = await query(
      'SELECT id FROM hub_modules WHERE name = $1',
      [name]
    );

    if (existingResult.rows.length > 0) {
      return next(errors.conflict('Module name already exists'));
    }

    const result = await query(
      `INSERT INTO hub_modules
       (name, display_name, description, version, author, category, icon_url, is_core, config_schema)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, display_name, created_at`,
      [
        name,
        displayName || name,
        description || '',
        version || '1.0.0',
        author || 'WaddleBot',
        category || 'general',
        iconUrl || null,
        isCore || false,
        JSON.stringify(configSchema || {}),
      ]
    );

    logger.audit('Module created', {
      adminId: req.user.platformUserId,
      moduleId: result.rows[0].id,
      name: result.rows[0].name,
    });

    res.status(201).json({
      success: true,
      module: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        displayName: result.rows[0].display_name,
        createdAt: result.rows[0].created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update a module
 * PUT /api/v1/superadmin/marketplace/modules/:id
 */
export async function updateModule(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const { displayName, description, version, author, category, iconUrl, isCore, configSchema } = req.body;

    // Check module exists
    const existingResult = await query(
      'SELECT id FROM hub_modules WHERE id = $1',
      [moduleId]
    );

    if (existingResult.rows.length === 0) {
      return next(errors.notFound('Module not found'));
    }

    const updates = [];
    const params = [moduleId];
    let paramIndex = 2;

    if (displayName !== undefined) {
      updates.push(`display_name = $${paramIndex++}`);
      params.push(displayName);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }
    if (version !== undefined) {
      updates.push(`version = $${paramIndex++}`);
      params.push(version);
    }
    if (author !== undefined) {
      updates.push(`author = $${paramIndex++}`);
      params.push(author);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramIndex++}`);
      params.push(category);
    }
    if (iconUrl !== undefined) {
      updates.push(`icon_url = $${paramIndex++}`);
      params.push(iconUrl);
    }
    if (isCore !== undefined) {
      updates.push(`is_core = $${paramIndex++}`);
      params.push(isCore);
    }
    if (configSchema !== undefined) {
      updates.push(`config_schema = $${paramIndex++}::jsonb`);
      params.push(JSON.stringify(configSchema));
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    updates.push('updated_at = NOW()');

    await query(
      `UPDATE hub_modules SET ${updates.join(', ')} WHERE id = $1`,
      params
    );

    logger.audit('Module updated', {
      adminId: req.user.platformUserId,
      moduleId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Module updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Publish/unpublish a module
 * PUT /api/v1/superadmin/marketplace/modules/:id/publish
 */
export async function publishModule(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const { isPublished } = req.body;

    if (isPublished === undefined) {
      return next(errors.badRequest('isPublished field is required'));
    }

    const result = await query(
      `UPDATE hub_modules SET is_published = $1, updated_at = NOW()
       WHERE id = $2 RETURNING name`,
      [isPublished, moduleId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Module not found'));
    }

    logger.audit('Module publication status changed', {
      adminId: req.user.platformUserId,
      moduleId,
      moduleName: result.rows[0].name,
      isPublished,
    });

    res.json({
      success: true,
      message: isPublished ? 'Module published' : 'Module unpublished',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete a module
 * DELETE /api/v1/superadmin/marketplace/modules/:id
 */
export async function deleteModule(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);

    // Check for existing installations
    const installCheck = await query(
      'SELECT COUNT(*) as count FROM hub_module_installations WHERE module_id = $1',
      [moduleId]
    );

    const installCount = parseInt(installCheck.rows[0]?.count || 0, 10);
    if (installCount > 0) {
      return next(errors.badRequest(
        `Cannot delete module: ${installCount} installations exist. Unpublish instead.`
      ));
    }

    const result = await query(
      'DELETE FROM hub_modules WHERE id = $1 RETURNING name',
      [moduleId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Module not found'));
    }

    logger.audit('Module deleted', {
      adminId: req.user.platformUserId,
      moduleId,
      moduleName: result.rows[0].name,
    });

    res.json({ success: true, message: 'Module deleted' });
  } catch (err) {
    next(err);
  }
}
