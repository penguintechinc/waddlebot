/**
 * Admin Routes - Community admin access
 */
import { Router } from 'express';
import * as adminController from '../controllers/adminController.js';
import { requireAuth, requireCommunityAdmin } from '../middleware/auth.js';

const router = Router();

// All routes require authentication and community admin role
router.use(requireAuth);

// Member management
router.get('/:communityId/members', requireCommunityAdmin, adminController.getMembers);
router.put('/:communityId/members/:userId/role', requireCommunityAdmin, adminController.updateMemberRole);
router.put('/:communityId/members/:userId/reputation', requireCommunityAdmin, adminController.adjustReputation);
router.delete('/:communityId/members/:userId', requireCommunityAdmin, adminController.removeMember);

// Module configuration
router.get('/:communityId/modules', requireCommunityAdmin, adminController.getModules);
router.put('/:communityId/modules/:moduleId/config', requireCommunityAdmin, adminController.updateModuleConfig);

// Browser source URLs
router.get('/:communityId/browser-sources', requireCommunityAdmin, adminController.getBrowserSources);
router.post('/:communityId/browser-sources/regenerate', requireCommunityAdmin, adminController.regenerateBrowserSources);

// Custom domains
router.get('/:communityId/domains', requireCommunityAdmin, adminController.getDomains);
router.post('/:communityId/domains', requireCommunityAdmin, adminController.addDomain);
router.post('/:communityId/domains/:domainId/verify', requireCommunityAdmin, adminController.verifyDomain);
router.delete('/:communityId/domains/:domainId', requireCommunityAdmin, adminController.removeDomain);

// Temp password generation
router.post('/:communityId/temp-password', requireCommunityAdmin, adminController.generateTempPassword);

export default router;
