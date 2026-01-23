/**
 * Streaming Management Routes - Video proxy streaming configuration
 */
import { Router } from 'express';
import * as streamingController from '../controllers/streamingController.js';
import { requireAuth, requireCommunityAdmin } from '../middleware/auth.js';
import { validators, validateRequest } from '../middleware/validation.js';

const router = Router({ mergeParams: true });

// All routes require authentication and community admin role
router.use(requireAuth);

/**
 * Stream Configuration
 */

// Get stream configuration for a community
router.get(
  '/:communityId/streams',
  requireCommunityAdmin,
  streamingController.getStreamConfig
);

// Create stream configuration for a community
router.post(
  '/:communityId/streams',
  requireCommunityAdmin,
  validators.integer('rtmpPort', { min: 1024, max: 65535, optional: true }),
  validators.integer('httpPort', { min: 1024, max: 65535, optional: true }),
  validators.boolean('enabled', { optional: true }),
  validateRequest,
  streamingController.createStreamConfig
);

// Regenerate stream key
router.post(
  '/:communityId/streams/key/regenerate',
  requireCommunityAdmin,
  streamingController.regenerateStreamKey
);

/**
 * Streaming Destinations
 */

// Get all destinations for a community
router.get(
  '/:communityId/streams/destinations',
  requireCommunityAdmin,
  streamingController.getDestinations
);

// Add a new destination
router.post(
  '/:communityId/streams/destinations',
  requireCommunityAdmin,
  validators.text('platform', { min: 1, max: 50 }),
  validators.text('rtmpUrl', { min: 1, max: 500 }),
  validators.text('streamKey', { min: 1, max: 500 }),
  validators.boolean('enabled', { optional: true }),
  validators.boolean('forceCut', { optional: true }),
  validateRequest,
  streamingController.addDestination
);

// Remove a destination
router.delete(
  '/:communityId/streams/destinations/:destinationId',
  requireCommunityAdmin,
  streamingController.removeDestination
);

// Toggle force cut for a destination
router.put(
  '/:communityId/streams/destinations/:destinationId/force-cut',
  requireCommunityAdmin,
  validators.boolean('forceCut'),
  validateRequest,
  streamingController.toggleForceCut
);

/**
 * Streaming Status
 */

// Get streaming status for a community
router.get(
  '/:communityId/streams/status',
  requireCommunityAdmin,
  streamingController.getStreamStatus
);

export default router;
