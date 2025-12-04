/**
 * User Routes - Identity linking and user management
 */
import { Router } from 'express';
import multer from 'multer';
import * as identityController from '../controllers/identityController.js';
import * as profileController from '../controllers/profileController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Configure multer for avatar uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// All user routes require authentication
router.use(requireAuth);

// Profile routes
router.get('/profile', profileController.getMyProfile);
router.put('/profile', profileController.updateMyProfile);
router.post('/profile/avatar', upload.single('avatar'), profileController.uploadAvatar);
router.delete('/profile/avatar', profileController.deleteAvatar);
router.get('/linked-platforms', profileController.getMyLinkedPlatforms);

// Identity linking routes
router.get('/identities', identityController.getLinkedIdentities);
router.get('/identities/primary', identityController.getPrimaryIdentity);
router.put('/identities/primary', identityController.setPrimaryIdentity);
router.post('/identities/link/:platform', identityController.startIdentityLink);
router.get('/identities/link/:platform/callback', identityController.identityLinkCallback);
router.delete('/identities/:platform', identityController.unlinkIdentity);

export default router;
