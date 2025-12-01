/**
 * Auth Routes - OAuth and temp password authentication
 */
import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();

// OAuth flow
router.get('/oauth/:platform', authController.startOAuth);
router.get('/oauth/:platform/callback', authController.oauthCallback);

// Temp password login
router.post('/temp-password', authController.tempPasswordLogin);

// Link OAuth after temp password login (requires auth)
router.post('/link-oauth', optionalAuth, authController.linkOAuth);

// Session management
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

// Current user info
router.get('/me', optionalAuth, authController.getCurrentUser);

export default router;
