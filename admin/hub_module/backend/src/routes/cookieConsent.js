/**
 * Cookie Consent Routes - GDPR Compliance
 * Public and authenticated endpoints for cookie consent management
 */
import { Router } from 'express';
import * as cookieConsentController from '../controllers/cookieConsentController.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

/**
 * Public routes (no authentication required)
 */

// Get current user/session consent status
router.get('/', cookieConsentController.getConsent);

// Save or update consent preferences
router.post('/', cookieConsentController.saveConsent);

// Get current active cookie policy
router.get('/policy', cookieConsentController.getCurrentPolicy);

// Get all policy versions
router.get('/policy/history', cookieConsentController.getPolicyHistory);

/**
 * Authenticated routes (requireAuth)
 */

// Update specific consent categories (requires auth)
router.patch('/preferences', requireAuth, cookieConsentController.updatePreferences);

// Revoke all non-essential cookies (requires auth)
router.delete('/', requireAuth, cookieConsentController.revokeConsent);

// Get user's consent audit log (requires auth)
router.get('/audit', requireAuth, cookieConsentController.getAuditLog);

/**
 * Super admin routes (requireSuperAdmin)
 */

// Create new policy version (super admin only)
router.post('/policy', requireSuperAdmin, cookieConsentController.createPolicyVersion);

// Activate existing policy version (super admin only)
router.put('/policy/:version/activate', requireSuperAdmin, cookieConsentController.activatePolicyVersion);

export default router;
