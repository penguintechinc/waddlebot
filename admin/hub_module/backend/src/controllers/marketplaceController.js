/**
 * Marketplace Controller - Module marketplace for community admins
 */
import { query, transaction } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Browse modules in marketplace
 * GET /api/v1/admin/:communityId/marketplace/modules
 */
export async function browseModules(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const category = req.query.category;

    let whereClause = 'WHERE is_published = true';
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as count FROM hub_modules ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    // Get modules with installation status
    const modulesResult = await query(
      `SELECT
        m.id, m.name, m.display_name, m.description, m.version,
        m.author, m.category, m.icon_url, m.is_core, m.created_at,
        i.id as installation_id, i.is_enabled,
        COALESCE(AVG(r.rating), 0) as avg_rating,
        COUNT(DISTINCT r.id) as review_count,
        COUNT(DISTINCT inst.id) as install_count
       FROM hub_modules m
       LEFT JOIN hub_module_installations i ON i.module_id = m.id AND i.community_id = $${paramIndex}
       LEFT JOIN hub_module_reviews r ON r.module_id = m.id
       LEFT JOIN hub_module_installations inst ON inst.module_id = m.id
       ${whereClause}
       GROUP BY m.id, i.id, i.is_enabled
       ORDER BY m.is_core DESC, m.created_at DESC
       LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`,
      [...params, communityId, limit, offset]
    );

    const modules = modulesResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      category: row.category,
      iconUrl: row.icon_url,
      isCore: row.is_core,
      isInstalled: !!row.installation_id,
      isEnabled: row.is_enabled || false,
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
 * Get module details
 * GET /api/v1/admin/:communityId/marketplace/modules/:id
 */
export async function getModuleDetails(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const moduleId = parseInt(req.params.id, 10);

    const moduleResult = await query(
      `SELECT
        m.id, m.name, m.display_name, m.description, m.version,
        m.author, m.category, m.icon_url, m.is_core, m.config_schema, m.created_at,
        i.id as installation_id, i.is_enabled, i.config, i.installed_at,
        COALESCE(AVG(r.rating), 0) as avg_rating,
        COUNT(DISTINCT r.id) as review_count,
        COUNT(DISTINCT inst.id) as install_count
       FROM hub_modules m
       LEFT JOIN hub_module_installations i ON i.module_id = m.id AND i.community_id = $1
       LEFT JOIN hub_module_reviews r ON r.module_id = m.id
       LEFT JOIN hub_module_installations inst ON inst.module_id = m.id
       WHERE m.id = $2 AND m.is_published = true
       GROUP BY m.id, i.id, i.is_enabled, i.config, i.installed_at`,
      [communityId, moduleId]
    );

    if (moduleResult.rows.length === 0) {
      return next(errors.notFound('Module not found'));
    }

    const row = moduleResult.rows[0];

    // Get reviews
    const reviewsResult = await query(
      `SELECT r.id, r.rating, r.review_text, r.created_at,
              cm.display_name, cm.avatar_url
       FROM hub_module_reviews r
       LEFT JOIN community_members cm ON cm.id = r.user_id AND cm.community_id = r.community_id
       WHERE r.module_id = $1
       ORDER BY r.created_at DESC
       LIMIT 10`,
      [moduleId]
    );

    const module = {
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      category: row.category,
      iconUrl: row.icon_url,
      isCore: row.is_core,
      configSchema: row.config_schema,
      isInstalled: !!row.installation_id,
      isEnabled: row.is_enabled || false,
      config: row.config || {},
      installedAt: row.installed_at?.toISOString(),
      avgRating: parseFloat(row.avg_rating || 0).toFixed(1),
      reviewCount: parseInt(row.review_count || 0, 10),
      installCount: parseInt(row.install_count || 0, 10),
      createdAt: row.created_at?.toISOString(),
      reviews: reviewsResult.rows.map(r => ({
        id: r.id,
        rating: r.rating,
        reviewText: r.review_text,
        author: r.display_name || 'Anonymous',
        authorAvatar: r.avatar_url,
        createdAt: r.created_at?.toISOString(),
      })),
    };

    res.json({ success: true, module });
  } catch (err) {
    next(err);
  }
}

/**
 * Install a module
 * POST /api/v1/admin/:communityId/marketplace/modules/:id/install
 */
export async function installModule(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const moduleId = parseInt(req.params.id, 10);

    // Check if module exists and is published
    const moduleResult = await query(
      'SELECT id, name FROM hub_modules WHERE id = $1 AND is_published = true',
      [moduleId]
    );

    if (moduleResult.rows.length === 0) {
      return next(errors.notFound('Module not found'));
    }

    // Check if already installed
    const existingResult = await query(
      'SELECT id FROM hub_module_installations WHERE community_id = $1 AND module_id = $2',
      [communityId, moduleId]
    );

    if (existingResult.rows.length > 0) {
      return next(errors.conflict('Module already installed'));
    }

    // Install the module
    const result = await query(
      `INSERT INTO hub_module_installations
       (community_id, module_id, installed_by, is_enabled)
       VALUES ($1, $2, $3, true)
       RETURNING id, installed_at`,
      [communityId, moduleId, req.user.id]
    );

    logger.audit('Module installed', {
      communityId,
      moduleId,
      moduleName: moduleResult.rows[0].name,
      installedBy: req.user.platformUserId,
    });

    res.status(201).json({
      success: true,
      message: 'Module installed successfully',
      installation: {
        id: result.rows[0].id,
        installedAt: result.rows[0].installed_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Uninstall a module
 * DELETE /api/v1/admin/:communityId/marketplace/modules/:id
 */
export async function uninstallModule(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const moduleId = parseInt(req.params.id, 10);

    // Get module name for audit
    const moduleResult = await query(
      'SELECT name FROM hub_modules WHERE id = $1',
      [moduleId]
    );

    const result = await query(
      'DELETE FROM hub_module_installations WHERE community_id = $1 AND module_id = $2 RETURNING id',
      [communityId, moduleId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Module installation not found'));
    }

    logger.audit('Module uninstalled', {
      communityId,
      moduleId,
      moduleName: moduleResult.rows[0]?.name,
      uninstalledBy: req.user.platformUserId,
    });

    res.json({ success: true, message: 'Module uninstalled successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Configure a module
 * PUT /api/v1/admin/:communityId/marketplace/modules/:id/config
 */
export async function configureModule(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const moduleId = parseInt(req.params.id, 10);
    const { config, isEnabled } = req.body;

    const updates = [];
    const params = [communityId, moduleId];
    let paramIndex = 3;

    if (config !== undefined) {
      updates.push(`config = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(config));
      paramIndex++;
    }

    if (isEnabled !== undefined) {
      updates.push(`is_enabled = $${paramIndex}`);
      params.push(isEnabled);
      paramIndex++;
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No configuration provided'));
    }

    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE hub_module_installations
       SET ${updates.join(', ')}
       WHERE community_id = $1 AND module_id = $2
       RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Module installation not found'));
    }

    logger.audit('Module configured', {
      communityId,
      moduleId,
      updatedBy: req.user.platformUserId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Module configuration updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Add a review
 * POST /api/v1/admin/:communityId/marketplace/modules/:id/review
 */
export async function addReview(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const moduleId = parseInt(req.params.id, 10);
    const { rating, reviewText } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return next(errors.badRequest('Rating must be between 1 and 5'));
    }

    // Check if module is installed
    const installCheck = await query(
      'SELECT id FROM hub_module_installations WHERE community_id = $1 AND module_id = $2',
      [communityId, moduleId]
    );

    if (installCheck.rows.length === 0) {
      return next(errors.badRequest('Module must be installed to leave a review'));
    }

    // Check for existing review
    const existingReview = await query(
      'SELECT id FROM hub_module_reviews WHERE module_id = $1 AND community_id = $2 AND user_id = $3',
      [moduleId, communityId, req.user.id]
    );

    if (existingReview.rows.length > 0) {
      // Update existing review
      await query(
        'UPDATE hub_module_reviews SET rating = $1, review_text = $2 WHERE id = $3',
        [rating, reviewText, existingReview.rows[0].id]
      );
    } else {
      // Create new review
      await query(
        `INSERT INTO hub_module_reviews
         (module_id, community_id, user_id, rating, review_text)
         VALUES ($1, $2, $3, $4, $5)`,
        [moduleId, communityId, req.user.id, rating, reviewText]
      );
    }

    logger.audit('Module review submitted', {
      communityId,
      moduleId,
      userId: req.user.platformUserId,
      rating,
    });

    res.json({ success: true, message: 'Review submitted successfully' });
  } catch (err) {
    next(err);
  }
}
