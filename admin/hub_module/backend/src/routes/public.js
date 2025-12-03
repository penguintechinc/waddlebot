/**
 * Public Routes - No authentication required
 */
import { Router } from 'express';
import * as publicController from '../controllers/publicController.js';

const router = Router();

// Platform statistics
router.get('/stats', publicController.getStats);

// Communities
router.get('/communities', publicController.getCommunities);
router.get('/communities/:id', publicController.getCommunity);

// Live streams
router.get('/live', publicController.getLiveStreams);
router.get('/live/:entityId', publicController.getStreamDetails);

// Signup settings (for login page to determine if signup is available)
router.get('/signup-settings', publicController.getSignupSettings);

export default router;
