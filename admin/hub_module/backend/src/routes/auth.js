/**
 * Auth Routes - Unified local login with OAuth platform linking
 */
import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Local auth (email/password)
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/admin', authController.adminLogin); // Legacy admin login

// Password management (requires auth)
router.post('/password', requireAuth, authController.setPassword);

// OAuth flow
router.get('/oauth/:platform', authController.startOAuth);
router.get('/oauth/:platform/callback', authController.oauthCallback);

// OAuth linking (requires auth)
router.get('/oauth/:platform/link', requireAuth, authController.linkOAuthAccount);
router.get('/oauth/:platform/link-callback', authController.oauthLinkCallback);
router.delete('/oauth/:platform', requireAuth, authController.unlinkOAuthAccount);

// Temp password login (legacy)
router.post('/temp-password', authController.tempPasswordLogin);
router.post('/link-oauth', optionalAuth, authController.linkOAuth);

// Session management
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

// Current user info
router.get('/me', optionalAuth, authController.getCurrentUser);

export default router;
