/**
 * Super Admin Routes - Global admin features for managing all communities
 */
import { Router } from 'express';
import * as superadminController from '../controllers/superadminController.js';
import * as platformConfigController from '../controllers/platformConfigController.js';
import * as kongController from '../controllers/kongController.js';
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

// Module registry management
router.get('/marketplace/modules', superadminController.getAllModules);
router.post('/marketplace/modules', superadminController.createModule);
router.put('/marketplace/modules/:id', superadminController.updateModule);
router.put('/marketplace/modules/:id/publish', superadminController.publishModule);
router.delete('/marketplace/modules/:id', superadminController.deleteModule);

// Platform configuration management
router.get('/platform-config', platformConfigController.getPlatformConfigs);
router.put('/platform-config/:platform', platformConfigController.updatePlatformConfig);
router.post('/platform-config/:platform/test', platformConfigController.testPlatformConnection);

// Hub settings management (signup, email, etc.)
router.get('/settings', platformConfigController.getHubSettings);
router.put('/settings', platformConfigController.updateHubSettings);

// Kong Gateway management
router.get('/kong/status', kongController.getStatus);

// Services
router.get('/kong/services', kongController.getServices);
router.get('/kong/services/:id', kongController.getService);
router.post('/kong/services', kongController.createService);
router.patch('/kong/services/:id', kongController.updateService);
router.delete('/kong/services/:id', kongController.deleteService);

// Routes
router.get('/kong/routes', kongController.getRoutes);
router.get('/kong/routes/:id', kongController.getRoute);
router.get('/kong/services/:serviceId/routes', kongController.getServiceRoutes);
router.post('/kong/services/:serviceId/routes', kongController.createRoute);
router.patch('/kong/routes/:id', kongController.updateRoute);
router.delete('/kong/routes/:id', kongController.deleteRoute);

// Plugins
router.get('/kong/plugins', kongController.getPlugins);
router.get('/kong/plugins/:id', kongController.getPlugin);
router.post('/kong/plugins', kongController.createPlugin);
router.patch('/kong/plugins/:id', kongController.updatePlugin);
router.delete('/kong/plugins/:id', kongController.deletePlugin);

// Consumers
router.get('/kong/consumers', kongController.getConsumers);
router.get('/kong/consumers/:id', kongController.getConsumer);
router.post('/kong/consumers', kongController.createConsumer);
router.delete('/kong/consumers/:id', kongController.deleteConsumer);

// Upstreams
router.get('/kong/upstreams', kongController.getUpstreams);
router.get('/kong/upstreams/:id', kongController.getUpstream);
router.post('/kong/upstreams', kongController.createUpstream);
router.patch('/kong/upstreams/:id', kongController.updateUpstream);
router.delete('/kong/upstreams/:id', kongController.deleteUpstream);

// Targets
router.get('/kong/upstreams/:upstreamId/targets', kongController.getTargets);
router.post('/kong/upstreams/:upstreamId/targets', kongController.createTarget);
router.delete('/kong/upstreams/:upstreamId/targets/:targetId', kongController.deleteTarget);

// Certificates
router.get('/kong/certificates', kongController.getCertificates);
router.get('/kong/certificates/:id', kongController.getCertificate);
router.post('/kong/certificates', kongController.createCertificate);
router.delete('/kong/certificates/:id', kongController.deleteCertificate);

// SNIs
router.get('/kong/snis', kongController.getSNIs);
router.post('/kong/snis', kongController.createSNI);
router.delete('/kong/snis/:id', kongController.deleteSNI);

export default router;
