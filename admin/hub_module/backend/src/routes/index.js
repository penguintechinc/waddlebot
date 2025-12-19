/**
 * Route Aggregator
 * Combines all API routes under /api/v1
 */
import { Router } from 'express';
import publicRoutes from './public.js';
import authRoutes from './auth.js';
import userRoutes from './user.js';
import communityRoutes from './community.js';
import adminRoutes from './admin.js';
import marketplaceRoutes from './marketplace.js';
import platformRoutes from './platform.js';
import superadminRoutes from './superadmin.js';
import internalRoutes from './internal.js';
<<<<<<< HEAD
import cookieConsentRoutes from './cookieConsent.js';
=======
>>>>>>> origin/main

const router = Router();

// Public routes (no auth required)
router.use('/public', publicRoutes);

// Auth routes (login, OAuth, temp password)
router.use('/auth', authRoutes);

<<<<<<< HEAD
// Cookie consent routes (GDPR compliance)
router.use('/cookie-consent', cookieConsentRoutes);

=======
>>>>>>> origin/main
// User routes (auth required - identity linking, profile)
router.use('/user', userRoutes);

// Community member routes (auth required)
router.use('/community', communityRoutes);
router.use('/communities', communityRoutes); // Alias for plural form

// Community admin routes (admin role required)
router.use('/admin', adminRoutes);

// Marketplace routes (admin role required)
router.use('/admin', marketplaceRoutes);

// Platform admin routes (platform-admin role required)
router.use('/platform', platformRoutes);

// Super admin routes (super_admin role required)
router.use('/superadmin', superadminRoutes);

// Internal routes (service-to-service, API key auth)
router.use('/internal', internalRoutes);

export default router;
