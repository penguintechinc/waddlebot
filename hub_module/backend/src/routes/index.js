/**
 * Route Aggregator
 * Combines all API routes under /api/v1
 */
import { Router } from 'express';
import publicRoutes from './public.js';
import authRoutes from './auth.js';
import communityRoutes from './community.js';
import adminRoutes from './admin.js';
import platformRoutes from './platform.js';

const router = Router();

// Public routes (no auth required)
router.use('/public', publicRoutes);

// Auth routes (login, OAuth, temp password)
router.use('/auth', authRoutes);

// Community member routes (auth required)
router.use('/community', communityRoutes);

// Community admin routes (admin role required)
router.use('/admin', adminRoutes);

// Platform admin routes (platform-admin role required)
router.use('/platform', platformRoutes);

export default router;
