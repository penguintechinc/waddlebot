/**
 * Subscription Routes - Community module subscriptions
 */
import { Router } from 'express';
import * as subscriptionController from '../controllers/subscriptionController.js';
import { requireAuth, requireCommunityAdmin } from '../middleware/auth.js';
import { validators, validateRequest } from '../middleware/validation.js';

const router = Router();

// All subscription routes require authentication
router.use(requireAuth);

// Get community subscriptions
router.get('/:communityId/subscriptions',
  requireCommunityAdmin,
  subscriptionController.getCommunitySubscriptions
);

// Subscribe to a module (install)
router.post('/:communityId/subscriptions',
  requireCommunityAdmin,
  validators.integer('moduleId', { min: 1, required: true }),
  validateRequest,
  subscriptionController.subscribeModule
);

// Update subscription configuration
router.put('/:communityId/subscriptions/:subscriptionId',
  requireCommunityAdmin,
  validators.boolean('isEnabled'),
  validateRequest,
  subscriptionController.updateSubscription
);

// Unsubscribe from a module (uninstall)
router.delete('/:communityId/subscriptions/:subscriptionId',
  requireCommunityAdmin,
  subscriptionController.unsubscribeModule
);

export default router;
