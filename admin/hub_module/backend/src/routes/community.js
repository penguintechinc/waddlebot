/**
 * Community Routes - Authenticated member access
 */
import { Router } from 'express';
import * as communityController from '../controllers/communityController.js';
import * as streamController from '../controllers/streamController.js';
import * as chatController from '../controllers/chatController.js';
import { requireAuth, requireMember } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// User's communities
router.get('/my', communityController.getMyCommunities);

// Community detail (requires membership)
router.get('/:id/dashboard', requireMember, communityController.getCommunityDashboard);
router.get('/:id/leaderboard', requireMember, communityController.getLeaderboard);
router.get('/:id/activity', requireMember, communityController.getActivityFeed);
router.get('/:id/events', requireMember, communityController.getEvents);
router.get('/:id/memories', requireMember, communityController.getMemories);
router.get('/:id/modules', requireMember, communityController.getInstalledModules);

// Chat routes
router.get('/:id/chat/history', requireMember, chatController.getChatHistory);
router.get('/:id/chat/channels', requireMember, chatController.getChatChannels);

// Live streams
router.get('/:communityId/streams', requireMember, streamController.getLiveStreams);
router.get('/:communityId/streams/featured', requireMember, streamController.getFeaturedStreams);
router.get('/:communityId/streams/:entityId', requireMember, streamController.getStreamDetails);

// Profile management
router.put('/:id/profile', requireMember, communityController.updateProfile);
router.post('/:id/leave', requireMember, communityController.leaveCommunity);

export default router;
