/**
 * Module Service - Business logic for marketplace modules
 */
import { query, transaction } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { errors } from '../middleware/errorHandler.js';

/**
 * Get paginated modules with filters
 */
export async function getModules({ page = 1, limit = 25, search = '', category = null, featured = null }) {
  const offset = (page - 1) * limit;
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

  if (featured !== null) {
    whereClause += ` AND is_featured = $${paramIndex}`;
    params.push(featured);
    paramIndex++;
  }

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as count FROM hub_modules ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count || 0, 10);

  // Get modules with aggregated stats
  const modulesResult = await query(
    `SELECT
      m.id, m.name, m.display_name, m.description, m.version,
      m.author, m.category, m.icon_url, m.is_core, m.is_featured,
      m.created_at, m.updated_at,
      COALESCE(AVG(r.rating), 0) as avg_rating,
      COUNT(DISTINCT r.id) as review_count,
      COUNT(DISTINCT inst.id) as install_count
     FROM hub_modules m
     LEFT JOIN hub_module_reviews r ON r.module_id = m.id
     LEFT JOIN hub_module_installations inst ON inst.module_id = m.id
     ${whereClause}
     GROUP BY m.id
     ORDER BY m.is_featured DESC, m.is_core DESC, m.created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  return {
    modules: modulesResult.rows.map(formatModule),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get module by ID with full details
 */
export async function getModuleById(moduleId) {
  const moduleResult = await query(
    `SELECT
      m.id, m.name, m.display_name, m.description, m.version,
      m.author, m.category, m.icon_url, m.is_core, m.is_featured,
      m.config_schema, m.created_at, m.updated_at,
      COALESCE(AVG(r.rating), 0) as avg_rating,
      COUNT(DISTINCT r.id) as review_count,
      COUNT(DISTINCT inst.id) as install_count
     FROM hub_modules m
     LEFT JOIN hub_module_reviews r ON r.module_id = m.id
     LEFT JOIN hub_module_installations inst ON inst.module_id = m.id
     WHERE m.id = $1 AND m.is_published = true
     GROUP BY m.id`,
    [moduleId]
  );

  if (moduleResult.rows.length === 0) {
    throw errors.notFound('Module not found');
  }

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

  const module = formatModule(moduleResult.rows[0]);
  module.configSchema = moduleResult.rows[0].config_schema;
  module.reviews = reviewsResult.rows.map(formatReview);

  return module;
}

/**
 * Create a new module
 */
export async function createModule(moduleData, userId) {
  const {
    name,
    displayName,
    description,
    version,
    author,
    category,
    iconUrl,
    configSchema,
    isCore = false,
    isFeatured = false,
  } = moduleData;

  const result = await query(
    `INSERT INTO hub_modules
     (name, display_name, description, version, author, category, icon_url,
      config_schema, is_core, is_featured, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
     RETURNING id, created_at`,
    [name, displayName, description, version, author, category, iconUrl,
     JSON.stringify(configSchema || {}), isCore, isFeatured]
  );

  logger.audit('Module created', {
    moduleId: result.rows[0].id,
    moduleName: name,
    createdBy: userId,
  });

  return {
    id: result.rows[0].id,
    createdAt: result.rows[0].created_at?.toISOString(),
  };
}

/**
 * Update a module
 */
export async function updateModule(moduleId, moduleData, userId) {
  const updates = [];
  const params = [moduleId];
  let paramIndex = 2;

  const allowedFields = [
    'display_name', 'description', 'version', 'author', 'category',
    'icon_url', 'config_schema', 'is_featured', 'is_published'
  ];

  for (const field of allowedFields) {
    const snakeField = field;
    const camelField = snakeField.replace(/_([a-z])/g, (g) => g[1].toUpperCase());

    if (moduleData[camelField] !== undefined) {
      if (field === 'config_schema') {
        updates.push(`${snakeField} = $${paramIndex}::jsonb`);
        params.push(JSON.stringify(moduleData[camelField]));
      } else {
        updates.push(`${snakeField} = $${paramIndex}`);
        params.push(moduleData[camelField]);
      }
      paramIndex++;
    }
  }

  if (updates.length === 0) {
    throw errors.badRequest('No fields to update');
  }

  updates.push('updated_at = NOW()');

  const result = await query(
    `UPDATE hub_modules
     SET ${updates.join(', ')}
     WHERE id = $1
     RETURNING id`,
    params
  );

  if (result.rows.length === 0) {
    throw errors.notFound('Module not found');
  }

  logger.audit('Module updated', {
    moduleId,
    updatedBy: userId,
    updates: Object.keys(moduleData),
  });

  return { success: true };
}

/**
 * Delete a module
 */
export async function deleteModule(moduleId, userId) {
  const result = await query(
    'DELETE FROM hub_modules WHERE id = $1 AND is_core = false RETURNING id, name',
    [moduleId]
  );

  if (result.rows.length === 0) {
    throw errors.notFound('Module not found or cannot delete core module');
  }

  logger.audit('Module deleted', {
    moduleId,
    moduleName: result.rows[0].name,
    deletedBy: userId,
  });

  return { success: true };
}

/**
 * Get community subscriptions for a module
 */
export async function getModuleSubscriptions(moduleId) {
  const result = await query(
    `SELECT
      i.id, i.community_id, i.is_enabled, i.config,
      i.installed_at, i.updated_at,
      c.name as community_name, c.display_name as community_display_name,
      c.logo_url as community_logo
     FROM hub_module_installations i
     INNER JOIN communities c ON c.id = i.community_id
     WHERE i.module_id = $1
     ORDER BY i.installed_at DESC`,
    [moduleId]
  );

  return result.rows.map(row => ({
    id: row.id,
    communityId: row.community_id,
    communityName: row.community_name,
    communityDisplayName: row.community_display_name,
    communityLogo: row.community_logo,
    isEnabled: row.is_enabled,
    config: row.config,
    installedAt: row.installed_at?.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
  }));
}

/**
 * Format module object
 */
function formatModule(row) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name || row.name,
    description: row.description,
    version: row.version,
    author: row.author,
    category: row.category,
    iconUrl: row.icon_url,
    isCore: row.is_core,
    isFeatured: row.is_featured,
    avgRating: parseFloat(row.avg_rating || 0).toFixed(1),
    reviewCount: parseInt(row.review_count || 0, 10),
    installCount: parseInt(row.install_count || 0, 10),
    createdAt: row.created_at?.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
  };
}

/**
 * Format review object
 */
function formatReview(row) {
  return {
    id: row.id,
    rating: row.rating,
    reviewText: row.review_text,
    author: row.display_name || 'Anonymous',
    authorAvatar: row.avatar_url,
    createdAt: row.created_at?.toISOString(),
  };
}

export default {
  getModules,
  getModuleById,
  createModule,
  updateModule,
  deleteModule,
  getModuleSubscriptions,
};
