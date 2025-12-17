/**
 * Module Routes - Marketplace module browsing and management
 */
import { Router } from 'express';
import * as moduleController from '../controllers/moduleController.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { validators, validateRequest } from '../middleware/validation.js';

const router = Router();

// Public routes (browsing modules)
router.get('/', moduleController.browseModules);
router.get('/:id', moduleController.getModuleDetails);

// Protected routes - require authentication
router.use(requireAuth);

// Super admin only routes
router.post('/',
  requireSuperAdmin,
  validators.text('name', { min: 3, max: 100, required: true }),
  validators.text('displayName', { min: 3, max: 255 }),
  validators.text('description', { min: 0, max: 5000 }),
  validators.text('version', { min: 1, max: 50, required: true }),
  validators.text('author', { min: 1, max: 255 }),
  validators.text('category', { min: 1, max: 100 }),
  validators.url('iconUrl'),
  validators.boolean('isCore'),
  validators.boolean('isFeatured'),
  validateRequest,
  moduleController.createModule
);

router.put('/:id',
  requireSuperAdmin,
  validators.text('displayName', { min: 3, max: 255 }),
  validators.text('description', { min: 0, max: 5000 }),
  validators.text('version', { min: 1, max: 50 }),
  validators.text('author', { min: 1, max: 255 }),
  validators.text('category', { min: 1, max: 100 }),
  validators.url('iconUrl'),
  validators.boolean('isFeatured'),
  validators.boolean('isPublished'),
  validateRequest,
  moduleController.updateModule
);

router.delete('/:id',
  requireSuperAdmin,
  moduleController.deleteModule
);

// Module subscription/installation statistics
router.get('/:id/subscriptions',
  requireSuperAdmin,
  moduleController.getModuleSubscriptions
);

export default router;
