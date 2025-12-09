/**
 * Workflow Routes - API endpoints for workflow management
 */
import { Router } from 'express';
import { requireAuth, requireCommunityAdmin } from '../middleware/auth.js';
import * as workflowController from '../controllers/workflowController.js';
import { validators, validateRequest } from '../middleware/validation.js';

const router = Router();

// All workflow routes require authentication and community admin role
router.use(requireAuth);

/**
 * Workflow CRUD operations
 */

// List workflows
router.get(
  '/:communityId/workflows',
  requireCommunityAdmin,
  workflowController.listWorkflows
);

// Create workflow
router.post(
  '/:communityId/workflows',
  requireCommunityAdmin,
  validators.text('name', { min: 3, max: 255 }),
  validators.text('description', { min: 0, max: 1000 }),
  validators.jsonString('definition'),
  validators.boolean('is_active'),
  validateRequest,
  workflowController.createWorkflow
);

// Get workflow details
router.get(
  '/:communityId/workflows/:workflowId',
  requireCommunityAdmin,
  workflowController.getWorkflow
);

// Update workflow
router.put(
  '/:communityId/workflows/:workflowId',
  requireCommunityAdmin,
  validators.text('name', { min: 3, max: 255 }),
  validators.text('description', { min: 0, max: 1000 }),
  validators.jsonString('definition'),
  validators.boolean('is_active'),
  validateRequest,
  workflowController.updateWorkflow
);

// Delete workflow
router.delete(
  '/:communityId/workflows/:workflowId',
  requireCommunityAdmin,
  workflowController.deleteWorkflow
);

/**
 * Workflow operations (publish, validate)
 */

// Publish workflow
router.post(
  '/:communityId/workflows/:workflowId/publish',
  requireCommunityAdmin,
  workflowController.publishWorkflow
);

// Validate workflow definition
router.post(
  '/:communityId/workflows/validate',
  requireCommunityAdmin,
  validators.jsonString('definition'),
  validateRequest,
  workflowController.validateWorkflow
);

/**
 * Workflow execution operations
 */

// Execute workflow
router.post(
  '/:communityId/workflows/:workflowId/execute',
  requireCommunityAdmin,
  workflowController.executeWorkflow
);

// Test execute workflow
router.post(
  '/:communityId/workflows/:workflowId/test',
  requireCommunityAdmin,
  workflowController.testWorkflow
);

// List executions for workflow
router.get(
  '/:communityId/workflows/:workflowId/executions',
  requireCommunityAdmin,
  workflowController.listExecutions
);

// Get execution details
router.get(
  '/:communityId/workflows/:workflowId/executions/:executionId',
  requireCommunityAdmin,
  workflowController.getExecution
);

// Cancel execution
router.post(
  '/:communityId/workflows/:workflowId/executions/:executionId/cancel',
  requireCommunityAdmin,
  workflowController.cancelExecution
);

/**
 * Workflow webhook operations
 */

// List webhooks
router.get(
  '/:communityId/workflows/:workflowId/webhooks',
  requireCommunityAdmin,
  workflowController.listWebhooks
);

// Create webhook
router.post(
  '/:communityId/workflows/:workflowId/webhooks',
  requireCommunityAdmin,
  validators.text('name', { min: 3, max: 255 }),
  validators.text('description', { min: 0, max: 500 }),
  validators.boolean('is_active'),
  validateRequest,
  workflowController.createWebhook
);

// Delete webhook
router.delete(
  '/:communityId/workflows/:workflowId/webhooks/:webhookId',
  requireCommunityAdmin,
  workflowController.deleteWebhook
);

export default router;
