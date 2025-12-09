/**
 * Admin Routes - Community admin access
 */
import { Router } from 'express';
import multer from 'multer';
import * as adminController from '../controllers/adminController.js';
import * as activityController from '../controllers/activityController.js';
import * as communityProfileController from '../controllers/communityProfileController.js';
import * as overlayController from '../controllers/overlayController.js';
import * as loyaltyController from '../controllers/loyaltyController.js';
import * as announcementController from '../controllers/announcementController.js';
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

// Reputation configuration (FICO-style scoring system)
router.get('/:communityId/reputation/config', requireCommunityAdmin, adminController.getReputationConfig);
router.put('/:communityId/reputation/config', requireCommunityAdmin, adminController.updateReputationConfig);
router.get('/:communityId/reputation/at-risk', requireCommunityAdmin, adminController.getAtRiskUsers);
router.get('/:communityId/reputation/leaderboard', requireCommunityAdmin, adminController.getReputationLeaderboard);

// AI Insights
router.get('/:communityId/ai-insights', requireCommunityAdmin, adminController.getAIInsights);
router.get('/:communityId/ai-insights/:insightId', requireCommunityAdmin, adminController.getAIInsight);

// AI Researcher Config
router.get('/:communityId/ai-researcher/config', requireCommunityAdmin, adminController.getAIResearcherConfig);
router.put('/:communityId/ai-researcher/config', requireCommunityAdmin, adminController.updateAIResearcherConfig);

// Bot Detection
router.get('/:communityId/bot-detection', requireCommunityAdmin, adminController.getBotDetectionResults);
router.post('/:communityId/bot-detection/:resultId/review', requireCommunityAdmin, adminController.reviewBotDetection);

// Context Visualization
router.get('/:communityId/ai-context', requireCommunityAdmin, adminController.getAIContext);

// Overlay management
router.get('/:communityId/overlay', requireCommunityAdmin, overlayController.getOverlay);
router.put('/:communityId/overlay', requireCommunityAdmin, overlayController.updateOverlay);
router.post('/:communityId/overlay/rotate', requireCommunityAdmin, overlayController.rotateKey);
router.get('/:communityId/overlay/stats', requireCommunityAdmin, overlayController.getOverlayStats);

// Loyalty module - Currency configuration
router.get('/:communityId/loyalty/config', requireCommunityAdmin, loyaltyController.getConfig);
router.put('/:communityId/loyalty/config', requireCommunityAdmin, loyaltyController.updateConfig);

// Loyalty module - Currency management
router.get('/:communityId/loyalty/leaderboard', requireCommunityAdmin, loyaltyController.getLeaderboard);
router.put('/:communityId/loyalty/user/:userId/balance', requireCommunityAdmin, loyaltyController.adjustUserBalance);
router.post('/:communityId/loyalty/wipe', requireCommunityAdmin, loyaltyController.wipeAllCurrency);
router.get('/:communityId/loyalty/stats', requireCommunityAdmin, loyaltyController.getStats);

// Loyalty module - Giveaways
router.get('/:communityId/loyalty/giveaways', requireCommunityAdmin, loyaltyController.getGiveaways);
router.post('/:communityId/loyalty/giveaways', requireCommunityAdmin, loyaltyController.createGiveaway);
router.get('/:communityId/loyalty/giveaways/:giveawayId/entries', requireCommunityAdmin, loyaltyController.getGiveawayEntries);
router.post('/:communityId/loyalty/giveaways/:giveawayId/draw', requireCommunityAdmin, loyaltyController.drawGiveawayWinner);
router.put('/:communityId/loyalty/giveaways/:giveawayId/end', requireCommunityAdmin, loyaltyController.endGiveaway);

// Loyalty module - Games
router.get('/:communityId/loyalty/games/config', requireCommunityAdmin, loyaltyController.getGamesConfig);
router.put('/:communityId/loyalty/games/config', requireCommunityAdmin, loyaltyController.updateGamesConfig);
router.get('/:communityId/loyalty/games/stats', requireCommunityAdmin, loyaltyController.getGamesStats);
router.get('/:communityId/loyalty/games/recent', requireCommunityAdmin, loyaltyController.getRecentGames);

// Loyalty module - Gear shop
router.get('/:communityId/loyalty/gear/categories', requireCommunityAdmin, loyaltyController.getGearCategories);
router.get('/:communityId/loyalty/gear/items', requireCommunityAdmin, loyaltyController.getGearItems);
router.post('/:communityId/loyalty/gear/items', requireCommunityAdmin, loyaltyController.createGearItem);
router.put('/:communityId/loyalty/gear/items/:itemId', requireCommunityAdmin, loyaltyController.updateGearItem);
router.delete('/:communityId/loyalty/gear/items/:itemId', requireCommunityAdmin, loyaltyController.deleteGearItem);
router.get('/:communityId/loyalty/gear/stats', requireCommunityAdmin, loyaltyController.getGearStats);

// Announcements (admin & moderator access)
router.get('/:communityId/announcements', requireCommunityAdmin, announcementController.getAnnouncements);
router.get('/:communityId/announcements/:announcementId', requireCommunityAdmin, announcementController.getAnnouncement);
router.post('/:communityId/announcements', requireCommunityAdmin, announcementController.createAnnouncement);
router.put('/:communityId/announcements/:announcementId', requireCommunityAdmin, announcementController.updateAnnouncement);
router.delete('/:communityId/announcements/:announcementId', requireCommunityAdmin, announcementController.deleteAnnouncement);

// Announcement actions
router.post('/:communityId/announcements/:announcementId/publish', requireCommunityAdmin, announcementController.publishAnnouncement);
router.put('/:communityId/announcements/:announcementId/pin', requireCommunityAdmin, announcementController.pinAnnouncement);
router.put('/:communityId/announcements/:announcementId/unpin', requireCommunityAdmin, announcementController.unpinAnnouncement);
router.post('/:communityId/announcements/:announcementId/archive', requireCommunityAdmin, announcementController.archiveAnnouncement);

// Broadcasting
router.post('/:communityId/announcements/:announcementId/broadcast', requireCommunityAdmin, announcementController.broadcastAnnouncement);
router.get('/:communityId/announcements/:announcementId/broadcast-status', requireCommunityAdmin, announcementController.getBroadcastStatus);

// Analytics proxy routes
router.get('/:communityId/analytics/*', requireCommunityAdmin, async (req, res) => {
  try {
    const httpClient = (await import('axios')).default;
    const analyticsPath = req.params[0];
    const response = await httpClient.get(
      `http://analytics-core:8040/api/v1/analytics/${req.params.communityId}/${analyticsPath}`,
      {
        params: req.query,
        headers: {
          'X-API-Key': req.headers['x-api-key'],
          'X-Community-ID': req.params.communityId,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Analytics proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error || 'Failed to fetch analytics',
    });
  }
});

// Security proxy routes
router.get('/:communityId/security/*', requireCommunityAdmin, async (req, res) => {
  try {
    const httpClient = (await import('axios')).default;
    const securityPath = req.params[0];
    const response = await httpClient.get(
      `http://security-core:8041/api/v1/security/${req.params.communityId}/${securityPath}`,
      {
        params: req.query,
        headers: {
          'X-API-Key': req.headers['x-api-key'],
          'X-Community-ID': req.params.communityId,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Security proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error || 'Failed to fetch security data',
    });
  }
});

router.put('/:communityId/security/*', requireCommunityAdmin, async (req, res) => {
  try {
    const httpClient = (await import('axios')).default;
    const securityPath = req.params[0];
    const response = await httpClient.put(
      `http://security-core:8041/api/v1/security/${req.params.communityId}/${securityPath}`,
      req.body,
      {
        params: req.query,
        headers: {
          'X-API-Key': req.headers['x-api-key'],
          'X-Community-ID': req.params.communityId,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Security proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error || 'Failed to update security settings',
    });
  }
});

router.post('/:communityId/security/*', requireCommunityAdmin, async (req, res) => {
  try {
    const httpClient = (await import('axios')).default;
    const securityPath = req.params[0];
    const response = await httpClient.post(
      `http://security-core:8041/api/v1/security/${req.params.communityId}/${securityPath}`,
      req.body,
      {
        params: req.query,
        headers: {
          'X-API-Key': req.headers['x-api-key'],
          'X-Community-ID': req.params.communityId,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Security proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error || 'Failed to process security action',
    });
  }
});

router.delete('/:communityId/security/*', requireCommunityAdmin, async (req, res) => {
  try {
    const httpClient = (await import('axios')).default;
    const securityPath = req.params[0];
    const response = await httpClient.delete(
      `http://security-core:8041/api/v1/security/${req.params.communityId}/${securityPath}`,
      {
        params: req.query,
        headers: {
          'X-API-Key': req.headers['x-api-key'],
          'X-Community-ID': req.params.communityId,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Security proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error || 'Failed to delete security item',
    });
  }
});

export default router;
