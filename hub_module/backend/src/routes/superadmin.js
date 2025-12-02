/**
 * Super Admin Routes - Global admin features for managing all communities
 */
import { Router } from 'express';
import * as superadminController from '../controllers/superadminController.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

// All routes require super admin authentication
router.use(requireAuth);
router.use(requireSuperAdmin);

// Dashboard stats
router.get('/dashboard', superadminController.getDashboardStats);

// Community management
router.get('/communities', superadminController.listCommunities);
router.get('/communities/:id', superadminController.getCommunity);
router.post('/communities', superadminController.createCommunity);
router.put('/communities/:id', superadminController.updateCommunity);
router.delete('/communities/:id', superadminController.deleteCommunity);
router.post('/communities/:id/reassign', superadminController.reassignOwner);

export default router;
