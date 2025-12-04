/**
 * Admin Routes - Community admin access
 */
import { Router } from 'express';
import multer from 'multer';
import * as adminController from '../controllers/adminController.js';
import * as activityController from '../controllers/activityController.js';
import * as communityProfileController from '../controllers/communityProfileController.js';
import { requireAuth, requireCommunityAdmin } from '../middleware/auth.js';

const router = Router();

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max for banners
});

// All routes require authentication and community admin role
router.use(requireAuth);

// Community settings
router.get('/:communityId/settings', requireCommunityAdmin, adminController.getCommunitySettings);
router.put('/:communityId/settings', requireCommunityAdmin, adminController.updateCommunitySettings);

// Join request management
router.get('/:communityId/join-requests', requireCommunityAdmin, adminController.getJoinRequests);
router.post('/:communityId/join-requests/:requestId/approve', requireCommunityAdmin, adminController.approveJoinRequest);
router.post('/:communityId/join-requests/:requestId/reject', requireCommunityAdmin, adminController.rejectJoinRequest);

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

// Server linking management
router.get('/:communityId/servers', requireCommunityAdmin, adminController.getLinkedServers);
router.put('/:communityId/servers/:serverId', requireCommunityAdmin, adminController.updateServer);
router.delete('/:communityId/servers/:serverId', requireCommunityAdmin, adminController.removeServer);

// Server link requests
router.get('/:communityId/server-link-requests', requireCommunityAdmin, adminController.getServerLinkRequests);
router.post('/:communityId/server-link-requests/:requestId/approve', requireCommunityAdmin, adminController.approveServerLinkRequest);
router.post('/:communityId/server-link-requests/:requestId/reject', requireCommunityAdmin, adminController.rejectServerLinkRequest);

// Mirror groups
router.get('/:communityId/mirror-groups', requireCommunityAdmin, adminController.getMirrorGroups);
router.post('/:communityId/mirror-groups', requireCommunityAdmin, adminController.createMirrorGroup);
router.get('/:communityId/mirror-groups/:groupId', requireCommunityAdmin, adminController.getMirrorGroup);
router.put('/:communityId/mirror-groups/:groupId', requireCommunityAdmin, adminController.updateMirrorGroup);
router.delete('/:communityId/mirror-groups/:groupId', requireCommunityAdmin, adminController.deleteMirrorGroup);

// Mirror group members
router.post('/:communityId/mirror-groups/:groupId/members', requireCommunityAdmin, adminController.addMirrorGroupMember);
router.put('/:communityId/mirror-groups/:groupId/members/:memberId', requireCommunityAdmin, adminController.updateMirrorGroupMember);
router.delete('/:communityId/mirror-groups/:groupId/members/:memberId', requireCommunityAdmin, adminController.removeMirrorGroupMember);

// Leaderboard configuration
router.get('/:communityId/leaderboard-config', requireCommunityAdmin, activityController.getLeaderboardConfig);
router.put('/:communityId/leaderboard-config', requireCommunityAdmin, activityController.updateLeaderboardConfig);

// Community profile management
router.put('/:communityId/profile', requireCommunityAdmin, communityProfileController.updateCommunityProfile);
router.post('/:communityId/logo', requireCommunityAdmin, upload.single('logo'), communityProfileController.uploadCommunityLogo);
router.delete('/:communityId/logo', requireCommunityAdmin, communityProfileController.deleteCommunityLogo);
router.post('/:communityId/banner', requireCommunityAdmin, upload.single('banner'), communityProfileController.uploadCommunityBanner);
router.delete('/:communityId/banner', requireCommunityAdmin, communityProfileController.deleteCommunityBanner);

export default router;
