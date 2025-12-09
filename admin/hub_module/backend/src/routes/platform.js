/**
 * Platform Admin Routes - Platform-wide admin access
 */
import { Router } from 'express';
import * as platformController from '../controllers/platformController.js';
import { requireAuth, requirePlatformAdmin } from '../middleware/auth.js';

const router = Router();

// All routes require authentication and platform-admin role
router.use(requireAuth);
router.use(requirePlatformAdmin);

// User management
router.get('/users', platformController.getUsers);
router.get('/users/:id', platformController.getUser);
router.put('/users/:id/role', platformController.updateUserRole);
router.delete('/users/:id', platformController.deactivateUser);

// Community management
router.get('/communities', platformController.getCommunities);
router.get('/communities/:id', platformController.getCommunity);
router.put('/communities/:id', platformController.updateCommunity);
router.delete('/communities/:id', platformController.deactivateCommunity);

// System
router.get('/health', platformController.getSystemHealth);
router.get('/modules', platformController.getModuleRegistry);
router.get('/audit-log', platformController.getAuditLog);
router.get('/stats', platformController.getStats);

export default router;
