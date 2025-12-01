/**
 * Community Routes - Authenticated member access
 */
import { Router } from 'express';
import * as communityController from '../controllers/communityController.js';
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

// Profile management
router.put('/:id/profile', requireMember, communityController.updateProfile);
router.post('/:id/leave', requireMember, communityController.leaveCommunity);

export default router;
