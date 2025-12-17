/**
 * Module Controller - CRUD operations for marketplace modules
 */
import * as moduleService from '../services/moduleService.js';
import { logger } from '../utils/logger.js';

/**
 * Browse modules in marketplace
 * GET /api/v1/modules
 */
export async function browseModules(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const search = req.query.search || '';
    const category = req.query.category;
    const featured = req.query.featured === 'true' ? true : req.query.featured === 'false' ? false : null;

    const result = await moduleService.getModules({
      page,
      limit,
      search,
      category,
      featured,
    });

    res.json({
      success: true,
      modules: result.modules,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get module details
 * GET /api/v1/modules/:id
 */
export async function getModuleDetails(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const module = await moduleService.getModuleById(moduleId);

    res.json({ success: true, module });
  } catch (err) {
    next(err);
  }
}

/**
 * Create a new module (super admin only)
 * POST /api/v1/modules
 */
export async function createModule(req, res, next) {
  try {
    const moduleData = {
      name: req.body.name,
      displayName: req.body.displayName,
      description: req.body.description,
      version: req.body.version,
      author: req.body.author,
      category: req.body.category,
      iconUrl: req.body.iconUrl,
      configSchema: req.body.configSchema,
      isCore: req.body.isCore,
      isFeatured: req.body.isFeatured,
    };

    const result = await moduleService.createModule(moduleData, req.user.id);

    res.status(201).json({
      success: true,
      message: 'Module created successfully',
      module: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update a module (super admin only)
 * PUT /api/v1/modules/:id
 */
export async function updateModule(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const moduleData = {
      displayName: req.body.displayName,
      description: req.body.description,
      version: req.body.version,
      author: req.body.author,
      category: req.body.category,
      iconUrl: req.body.iconUrl,
      configSchema: req.body.configSchema,
      isFeatured: req.body.isFeatured,
      isPublished: req.body.isPublished,
    };

    await moduleService.updateModule(moduleId, moduleData, req.user.id);

    res.json({ success: true, message: 'Module updated successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete a module (super admin only)
 * DELETE /api/v1/modules/:id
 */
export async function deleteModule(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);
    await moduleService.deleteModule(moduleId, req.user.id);

    res.json({ success: true, message: 'Module deleted successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get module subscriptions/installations
 * GET /api/v1/modules/:id/subscriptions
 */
export async function getModuleSubscriptions(req, res, next) {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const subscriptions = await moduleService.getModuleSubscriptions(moduleId);

    res.json({
      success: true,
      subscriptions,
      total: subscriptions.length,
    });
  } catch (err) {
    next(err);
  }
}

export default {
  browseModules,
  getModuleDetails,
  createModule,
  updateModule,
  deleteModule,
  getModuleSubscriptions,
};
