/**
 * Workflow Controller - Proxy for workflow-core module
 * Handles CRUD operations, execution, and webhook management for workflows
 * Proxies requests to workflow-core API and includes license validation
 */
import axios from 'axios';
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const WORKFLOW_CORE_URL = process.env.WORKFLOW_CORE_URL || 'http://workflow-core:8070';

/**
 * Helper: Check if community has valid workflow license
 */
async function validateLicense(communityId) {
  try {
    const result = await query(
      `SELECT license_key, license_expires_at, license_tier
       FROM communities
       WHERE id = $1`,
      [communityId]
    );

    if (result.rows.length === 0) {
      return { valid: false, reason: 'Community not found' };
    }

    const community = result.rows[0];

    // Check if license exists and is not expired
    if (!community.license_key) {
      return { valid: false, reason: 'No license configured' };
    }

    if (community.license_expires_at && new Date(community.license_expires_at) < new Date()) {
      return { valid: false, reason: 'License expired' };
    }

    // Check if tier includes workflows (typically pro+ tiers)
    const workflowTiers = ['pro', 'enterprise', 'premium'];
    if (!workflowTiers.includes(community.license_tier?.toLowerCase())) {
      return { valid: false, reason: 'Workflows not included in current license tier' };
    }

    return { valid: true };
  } catch (err) {
    logger.error('License validation error', { communityId, error: err.message });
    return { valid: false, reason: 'License validation failed' };
  }
}

/**
 * Helper: Make proxied request to workflow-core
 */
async function proxyRequest(method, path, data = null, params = null) {
  try {
    const config = {
      method,
      url: `${WORKFLOW_CORE_URL}/api/v1${path}`,
      ...(params && { params }),
      ...(data && { data }),
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const response = await axios(config);
    return response.data;
  } catch (err) {
    // Re-throw axios errors with proper details
    if (err.response) {
      throw {
        statusCode: err.response.status,
        message: err.response.data?.message || err.response.data?.error || err.message,
        code: err.response.data?.code || 'WORKFLOW_ERROR',
      };
    }
    throw {
      statusCode: 500,
      message: `Failed to connect to workflow service: ${err.message}`,
      code: 'SERVICE_UNAVAILABLE',
    };
  }
}

/**
 * Create a new workflow
 * POST /api/v1/admin/:communityId/workflows
 */
export async function createWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { name, description, definition } = req.body;

    // Validate inputs
    if (!name || !definition) {
      return next(errors.badRequest('Name and definition are required'));
    }

    // Check license
    const licenseCheck = await validateLicense(communityId);
    if (!licenseCheck.valid) {
      logger.authz('Workflow creation denied - license issue', {
        communityId,
        userId: req.user.id,
        reason: licenseCheck.reason,
      });
      return next(errors.forbidden(`Workflows not available: ${licenseCheck.reason}`));
    }

    // Proxy request to workflow-core
    const result = await proxyRequest('POST', '/workflows', {
      communityId,
      name,
      description: description || null,
      definition,
      createdBy: req.user.id,
    });

    logger.audit('Workflow created', {
      communityId,
      workflowId: result.id,
      workflowName: name,
      createdBy: req.user.platformUserId,
    });

    res.status(201).json({
      success: true,
      workflow: result,
    });
  } catch (err) {
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * List workflows for a community
 * GET /api/v1/admin/:communityId/workflows
 */
export async function listWorkflows(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const status = req.query.status; // active, draft, archived

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'GET',
      `/workflows?communityId=${communityId}`,
      null,
      { page, limit, ...(status && { status }) }
    );

    logger.audit('Workflows listed', {
      communityId,
      userId: req.user.id,
      count: result.workflows?.length || 0,
    });

    res.json({
      success: true,
      workflows: result.workflows || [],
      pagination: result.pagination || { page, limit, total: 0, totalPages: 0 },
    });
  } catch (err) {
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Get workflow details
 * GET /api/v1/admin/:communityId/workflows/:workflowId
 */
export async function getWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'GET',
      `/workflows/${workflowId}?communityId=${communityId}`
    );

    // Verify community ownership
    if (result.communityId !== communityId) {
      logger.authz('Workflow access denied - community mismatch', {
        communityId,
        workflowId,
        userId: req.user.id,
      });
      return next(errors.forbidden('Access denied'));
    }

    res.json({
      success: true,
      workflow: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Update a workflow
 * PUT /api/v1/admin/:communityId/workflows/:workflowId
 */
export async function updateWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const { name, description, definition } = req.body;

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'PUT',
      `/workflows/${workflowId}`,
      {
        communityId,
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(definition && { definition }),
        updatedBy: req.user.id,
      }
    );

    logger.audit('Workflow updated', {
      communityId,
      workflowId,
      workflowName: name || result.name,
      updatedBy: req.user.platformUserId,
      changes: Object.keys(req.body),
    });

    res.json({
      success: true,
      workflow: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Delete a workflow
 * DELETE /api/v1/admin/:communityId/workflows/:workflowId
 */
export async function deleteWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;

    // Proxy request to workflow-core
    await proxyRequest(
      'DELETE',
      `/workflows/${workflowId}`,
      { communityId, deletedBy: req.user.id }
    );

    logger.audit('Workflow deleted', {
      communityId,
      workflowId,
      deletedBy: req.user.platformUserId,
    });

    res.json({ success: true, message: 'Workflow deleted successfully' });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Publish a workflow (make it active)
 * POST /api/v1/admin/:communityId/workflows/:workflowId/publish
 */
export async function publishWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;

    // Check license
    const licenseCheck = await validateLicense(communityId);
    if (!licenseCheck.valid) {
      logger.authz('Workflow publish denied - license issue', {
        communityId,
        workflowId,
        userId: req.user.id,
      });
      return next(errors.forbidden(`Workflows not available: ${licenseCheck.reason}`));
    }

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'POST',
      `/workflows/${workflowId}/publish`,
      { communityId, publishedBy: req.user.id }
    );

    logger.audit('Workflow published', {
      communityId,
      workflowId,
      workflowName: result.name,
      publishedBy: req.user.platformUserId,
    });

    res.json({
      success: true,
      workflow: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Validate a workflow definition
 * POST /api/v1/admin/:communityId/workflows/validate
 */
export async function validateWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { definition } = req.body;

    if (!definition) {
      return next(errors.badRequest('Workflow definition is required'));
    }

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'POST',
      '/workflows/validate',
      { communityId, definition }
    );

    logger.debug('Workflow validated', {
      communityId,
      userId: req.user.id,
      isValid: result.isValid,
    });

    res.json({
      success: true,
      isValid: result.isValid,
      errors: result.errors || [],
      warnings: result.warnings || [],
    });
  } catch (err) {
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Execute a workflow
 * POST /api/v1/admin/:communityId/workflows/:workflowId/execute
 */
export async function executeWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const { input, context } = req.body;

    // Check license
    const licenseCheck = await validateLicense(communityId);
    if (!licenseCheck.valid) {
      logger.authz('Workflow execution denied - license issue', {
        communityId,
        workflowId,
        userId: req.user.id,
      });
      return next(errors.forbidden(`Workflows not available: ${licenseCheck.reason}`));
    }

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'POST',
      `/workflows/${workflowId}/execute`,
      {
        communityId,
        input: input || {},
        context: context || {},
        executedBy: req.user.id,
      }
    );

    logger.audit('Workflow executed', {
      communityId,
      workflowId,
      executionId: result.executionId,
      executedBy: req.user.platformUserId,
    });

    res.json({
      success: true,
      execution: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Get execution details
 * GET /api/v1/admin/:communityId/workflows/:workflowId/executions/:executionId
 */
export async function getExecution(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const executionId = req.params.executionId;

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'GET',
      `/workflows/${workflowId}/executions/${executionId}?communityId=${communityId}`
    );

    res.json({
      success: true,
      execution: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Execution not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Cancel execution
 * POST /api/v1/admin/:communityId/workflows/:workflowId/executions/:executionId/cancel
 */
export async function cancelExecution(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const executionId = req.params.executionId;

    // Proxy request to workflow-core
    await proxyRequest(
      'POST',
      `/workflows/${workflowId}/executions/${executionId}/cancel`,
      { communityId, cancelledBy: req.user.id }
    );

    logger.audit('Workflow execution cancelled', {
      communityId,
      workflowId,
      executionId,
      cancelledBy: req.user.platformUserId,
    });

    res.json({ success: true, message: 'Execution cancelled successfully' });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Execution not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * List executions for a workflow
 * GET /api/v1/admin/:communityId/workflows/:workflowId/executions
 */
export async function listExecutions(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const status = req.query.status; // pending, running, success, failed

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'GET',
      `/workflows/${workflowId}/executions?communityId=${communityId}`,
      null,
      { page, limit, ...(status && { status }) }
    );

    res.json({
      success: true,
      executions: result.executions || [],
      pagination: result.pagination || { page, limit, total: 0, totalPages: 0 },
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Test execute a workflow with validation
 * POST /api/v1/admin/:communityId/workflows/:workflowId/test
 */
export async function testWorkflow(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const { input, context } = req.body;

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'POST',
      `/workflows/${workflowId}/test`,
      {
        communityId,
        input: input || {},
        context: context || {},
        testedBy: req.user.id,
      }
    );

    logger.debug('Workflow test executed', {
      communityId,
      workflowId,
      testedBy: req.user.id,
      success: result.success,
    });

    res.json({
      success: true,
      result: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * List webhooks for a workflow
 * GET /api/v1/admin/:communityId/workflows/:workflowId/webhooks
 */
export async function listWebhooks(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'GET',
      `/workflows/${workflowId}/webhooks?communityId=${communityId}`
    );

    res.json({
      success: true,
      webhooks: result.webhooks || [],
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Create webhook for a workflow
 * POST /api/v1/admin/:communityId/workflows/:workflowId/webhooks
 */
export async function createWebhook(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const { event, url, retryCount, retryDelay } = req.body;

    if (!event || !url) {
      return next(errors.badRequest('Event and URL are required'));
    }

    // Proxy request to workflow-core
    const result = await proxyRequest(
      'POST',
      `/workflows/${workflowId}/webhooks`,
      {
        communityId,
        event,
        url,
        retryCount: retryCount || 3,
        retryDelay: retryDelay || 5000,
        createdBy: req.user.id,
      }
    );

    logger.audit('Workflow webhook created', {
      communityId,
      workflowId,
      webhookId: result.id,
      event,
      createdBy: req.user.platformUserId,
    });

    res.status(201).json({
      success: true,
      webhook: result,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Workflow not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}

/**
 * Delete webhook
 * DELETE /api/v1/admin/:communityId/workflows/:workflowId/webhooks/:webhookId
 */
export async function deleteWebhook(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const workflowId = req.params.workflowId;
    const webhookId = req.params.webhookId;

    // Proxy request to workflow-core
    await proxyRequest(
      'DELETE',
      `/workflows/${workflowId}/webhooks/${webhookId}`,
      { communityId, deletedBy: req.user.id }
    );

    logger.audit('Workflow webhook deleted', {
      communityId,
      workflowId,
      webhookId,
      deletedBy: req.user.platformUserId,
    });

    res.json({ success: true, message: 'Webhook deleted successfully' });
  } catch (err) {
    if (err.statusCode === 404) {
      return next(errors.notFound('Webhook not found'));
    }
    if (err.statusCode) {
      return next(errors.internal(err.message));
    }
    next(err);
  }
}
