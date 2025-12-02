/**
 * User Routes - Identity linking and user management
 */
import { Router } from 'express';
import * as identityController from '../controllers/identityController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All user routes require authentication
router.use(requireAuth);

// Identity linking routes
router.get('/identities', identityController.getLinkedIdentities);
router.get('/identities/primary', identityController.getPrimaryIdentity);
router.put('/identities/primary', identityController.setPrimaryIdentity);
router.post('/identities/link/:platform', identityController.startIdentityLink);
router.get('/identities/link/:platform/callback', identityController.identityLinkCallback);
router.delete('/identities/:platform', identityController.unlinkIdentity);

export default router;
