/**
 * Internal Routes - Service-to-service communication
 * These routes are secured by API key authentication
 */
import { Router } from 'express';
import * as activityController from '../controllers/activityController.js';
import { requireServiceAuth } from '../middleware/auth.js';

const router = Router();

// All routes require service API key authentication
router.use(requireServiceAuth);

// Activity tracking endpoints (called by trigger modules and router)
router.post('/activity/watch-session', activityController.recordWatchSession);
router.post('/activity/message', activityController.recordMessage);
router.post('/activity/batch', activityController.recordActivityBatch);

// Background job endpoints
router.post('/activity/close-stale-sessions', activityController.closeStaleWatchSessions);

export default router;
