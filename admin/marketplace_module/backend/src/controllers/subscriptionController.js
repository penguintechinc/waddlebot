/**
 * Subscription Controller - Community module subscriptions/installations
 */
import { query, transaction } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Get community subscriptions
 * GET /api/v1/communities/:communityId/subscriptions
 */
export async function getCommunitySubscriptions(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    const result = await query(
      `SELECT
        i.id, i.module_id, i.is_enabled, i.config,
        i.installed_at, i.updated_at,
        m.name, m.display_name, m.description, m.version,
        m.author, m.category, m.icon_url, m.is_core
       FROM hub_module_installations i
       INNER JOIN hub_modules m ON m.id = i.module_id
       WHERE i.community_id = $1
       ORDER BY m.is_core DESC, i.installed_at DESC`,
      [communityId]
    );

    const subscriptions = result.rows.map(row => ({
      id: row.id,
      moduleId: row.module_id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      category: row.category,
      iconUrl: row.icon_url,
      isCore: row.is_core,
      isEnabled: row.is_enabled,
      config: row.config,
      installedAt: row.installed_at?.toISOString(),
      updatedAt: row.updated_at?.toISOString(),
    }));

    res.json({
      success: true,
      subscriptions,
      total: subscriptions.length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Subscribe to a module (install)
 * POST /api/v1/communities/:communityId/subscriptions
 */
export async function subscribeModule(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { moduleId } = req.body;

    if (!moduleId) {
      return next(errors.badRequest('moduleId is required'));
    }

    // Check if module exists and is published
    const moduleResult = await query(
      'SELECT id, name FROM hub_modules WHERE id = $1 AND is_published = true',
      [moduleId]
    );

    if (moduleResult.rows.length === 0) {
      return next(errors.notFound('Module not found'));
    }

    // Check if already subscribed
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

    logger.audit('Module subscribed', {
      communityId,
      moduleId,
      moduleName: moduleResult.rows[0].name,
      subscribedBy: req.user.platformUserId,
    });

    res.status(201).json({
      success: true,
      message: 'Module subscribed successfully',
      subscription: {
        id: result.rows[0].id,
        installedAt: result.rows[0].installed_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Unsubscribe from a module (uninstall)
 * DELETE /api/v1/communities/:communityId/subscriptions/:subscriptionId
 */
export async function unsubscribeModule(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const subscriptionId = parseInt(req.params.subscriptionId, 10);

    // Get module name for audit
    const moduleResult = await query(
      `SELECT m.name, m.is_core
       FROM hub_module_installations i
       INNER JOIN hub_modules m ON m.id = i.module_id
       WHERE i.id = $1 AND i.community_id = $2`,
      [subscriptionId, communityId]
    );

    if (moduleResult.rows.length === 0) {
      return next(errors.notFound('Subscription not found'));
    }

    if (moduleResult.rows[0].is_core) {
      return next(errors.badRequest('Cannot unsubscribe from core modules'));
    }

    const result = await query(
      'DELETE FROM hub_module_installations WHERE id = $1 AND community_id = $2 RETURNING id',
      [subscriptionId, communityId]
    );

    logger.audit('Module unsubscribed', {
      communityId,
      subscriptionId,
      moduleName: moduleResult.rows[0].name,
      unsubscribedBy: req.user.platformUserId,
    });

    res.json({ success: true, message: 'Module unsubscribed successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Update subscription configuration
 * PUT /api/v1/communities/:communityId/subscriptions/:subscriptionId
 */
export async function updateSubscription(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const subscriptionId = parseInt(req.params.subscriptionId, 10);
    const { config, isEnabled } = req.body;

    const updates = [];
    const params = [subscriptionId, communityId];
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
       WHERE id = $1 AND community_id = $2
       RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Subscription not found'));
    }

    logger.audit('Subscription configured', {
      communityId,
      subscriptionId,
      updatedBy: req.user.platformUserId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Subscription updated successfully' });
  } catch (err) {
    next(err);
  }
}

export default {
  getCommunitySubscriptions,
  subscribeModule,
  unsubscribeModule,
  updateSubscription,
};
