/**
 * Music Routes - Community music settings and radio stations
 */
import { Router } from 'express';
import * as musicController from '../controllers/musicController.js';
import { requireAuth, requireCommunityAdmin } from '../middleware/auth.js';
import { validators, validateRequest } from '../middleware/validation.js';

const router = Router({ mergeParams: true });

// All routes require authentication and community admin role
router.use(requireAuth);

/**
 * Music Settings
 */

// Get music settings for a community
router.get('/:communityId/music/settings', requireCommunityAdmin, musicController.getMusicSettings);

// Update music settings for a community
router.put(
  '/:communityId/music/settings',
  requireCommunityAdmin,
  validators.text('defaultProvider', { min: 1, max: 50 }),
  validators.boolean('autoplayEnabled'),
  validators.integer('volumeLimit', { min: 0, max: 100 }),
  validators.arrayOfStrings('allowedGenres'),
  validators.arrayOfStrings('blockedArtists'),
  validators.boolean('requireDjApproval'),
  validators.boolean('isActive'),
  validateRequest,
  musicController.updateMusicSettings
);

/**
 * Music Providers (OAuth integration)
 */

// List configured music providers
router.get('/:communityId/music/providers', requireCommunityAdmin, musicController.getProviders);

// Start OAuth flow for a music provider
router.post(
  '/:communityId/music/providers/:provider/oauth',
  requireCommunityAdmin,
  validators.text('redirectUri', { min: 5, max: 2048 }),
  validateRequest,
  musicController.startOAuth
);

// Disconnect a music provider
router.delete(
  '/:communityId/music/providers/:provider',
  requireCommunityAdmin,
  musicController.disconnectProvider
);

// Update provider configuration
router.put(
  '/:communityId/music/providers/:provider/config',
  requireCommunityAdmin,
  validators.jsonString('config'),
  validateRequest,
  musicController.updateProviderConfig
);

/**
 * Radio Stations
 */

// List radio stations for a community
router.get('/:communityId/music/radio-stations', requireCommunityAdmin, musicController.getRadioStations);

// Add a new radio station
router.post(
  '/:communityId/music/radio-stations',
  requireCommunityAdmin,
  validators.text('name', { min: 3, max: 255 }),
  validators.text('url', { min: 5, max: 2048 }),
  validators.text('description', { min: 0, max: 1000 }),
  validators.text('genre', { min: 1, max: 100 }),
  validators.boolean('isActive'),
  validateRequest,
  musicController.addRadioStation
);

// Remove a radio station
router.delete(
  '/:communityId/music/radio-stations/:id',
  requireCommunityAdmin,
  musicController.removeRadioStation
);

// Test a radio station (check if it's accessible)
router.post(
  '/:communityId/music/radio-stations/:id/test',
  requireCommunityAdmin,
  musicController.testRadioStation
);

// Set a radio station as default
router.post(
  '/:communityId/music/radio-stations/:id/set-default',
  requireCommunityAdmin,
  musicController.setDefaultRadioStation
);

/**
 * Dashboard and Playback
 */

// Get music dashboard data (stats, active providers, etc.)
router.get('/:communityId/music/dashboard', requireCommunityAdmin, musicController.getMusicDashboard);

// Playback control actions (play, pause, skip, etc.)
router.post(
  '/:communityId/music/playback/:action',
  requireCommunityAdmin,
  validators.text('stationId', { min: 1, max: 255 }),
  validateRequest,
  musicController.controlPlayback
);

export default router;
