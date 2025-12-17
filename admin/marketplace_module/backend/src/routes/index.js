/**
 * Route Aggregator
 * Combines all API routes under /api/v1
 */
import { Router } from 'express';
import moduleRoutes from './modules.js';
import subscriptionRoutes from './subscriptions.js';

const router = Router();

// Module routes (browsing, details, management)
router.use('/modules', moduleRoutes);

// Subscription routes (community installations)
router.use('/communities', subscriptionRoutes);

export default router;
