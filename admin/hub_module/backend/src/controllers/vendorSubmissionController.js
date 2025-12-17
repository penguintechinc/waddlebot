/**
 * Vendor Submission Controller
 * Handles vendor module submissions, approvals, and marketplace publishing
 */
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Scope definitions with risk levels
const SCOPE_DEFINITIONS = {
  'read_chat': { name: 'Read Chat Messages', riskLevel: 'low', dataShared: 'Chat messages from channels' },
  'send_message': { name: 'Send Messages', riskLevel: 'medium', dataShared: 'Ability to post messages' },
  'read_profile': { name: 'Read User Profiles', riskLevel: 'low', dataShared: 'User profile information' },
  'read_viewers': { name: 'Read Viewer List', riskLevel: 'low', dataShared: 'Active viewer/user list' },
  'modify_settings': { name: 'Modify Community Settings', riskLevel: 'high', dataShared: 'Full community configuration access' },
  'control_music': { name: 'Control Music Player', riskLevel: 'medium', dataShared: 'Music playback control' },
  'read_music': { name: 'Read Music Queue', riskLevel: 'low', dataShared: 'Current music queue' },
  'read_permissions': { name: 'Read Permissions', riskLevel: 'medium', dataShared: 'User role and permission data' },
  'modify_permissions': { name: 'Modify Permissions', riskLevel: 'critical', dataShared: 'Full permission modification' },
  'delete_data': { name: 'Delete Community Data', riskLevel: 'critical', dataShared: 'Ability to delete any community data' },
};

const PAYMENT_METHODS = ['paypal', 'stripe', 'check', 'bank_transfer', 'other'];
const PRICING_MODELS = ['flat-rate', 'per-seat'];
const MODULE_CATEGORIES = ['interactive', 'pushing', 'security', 'marketplace', 'other'];

/**
 * Submit a new vendor module for review
 */
export async function submitVendorModule(req, res, next) {
  try {
    const {
      vendorName,
      vendorEmail,
      companyName,
      contactPhone,
      websiteUrl,
      moduleName,
      moduleDescription,
      moduleCategory,
      moduleVersion,
      repositoryUrl,
      webhookUrl,
      webhookSecret,
      webhookPerCommunity,
      scopes,
      scopeJustification,
      pricingModel,
      pricingAmount,
      pricingCurrency = 'USD',
      paymentMethod,
      paymentDetails,
      supportedPlatforms,
      documentationUrl,
      supportEmail,
      supportContactUrl,
    } = req.body;

    // Validation
    const errors = validateSubmission({
      vendorName,
      vendorEmail,
      moduleName,
      webhookUrl,
      scopes,
      pricingModel,
      pricingAmount,
      paymentMethod,
      paymentDetails,
    });

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors,
      });
    }

    // Check for existing submissions from this vendor with same module name
    const existing = await query(
      `SELECT id FROM vendor_submissions
       WHERE vendor_email = $1 AND module_name = $2
       AND status NOT IN ('rejected', 'suspended')`,
      [vendorEmail, moduleName]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active submission for this module',
      });
    }

    const submissionId = uuidv4();
    const encryptedSecret = webhookSecret ? encryptWebhookSecret(webhookSecret) : null;

    // Insert main submission record
    const result = await query(
      `INSERT INTO vendor_submissions (
        submission_id, vendor_name, vendor_email, company_name, contact_phone,
        website_url, module_name, module_description, module_category,
        module_version, repository_url, webhook_url, webhook_secret,
        webhook_per_community, scopes, scope_justification, pricing_model,
        pricing_amount, pricing_currency, payment_method, payment_details,
        supported_platforms, documentation_url, support_email, support_contact_url,
        submitted_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW()
      ) RETURNING id, submission_id, created_at`,
      [
        submissionId, vendorName, vendorEmail, companyName, contactPhone,
        websiteUrl, moduleName, moduleDescription, moduleCategory,
        moduleVersion, repositoryUrl, webhookUrl, encryptedSecret,
        webhookPerCommunity || false, JSON.stringify(scopes), scopeJustification,
        pricingModel, pricingAmount, pricingCurrency, paymentMethod,
        JSON.stringify(paymentDetails), JSON.stringify(supportedPlatforms || []),
        documentationUrl, supportEmail, supportContactUrl,
      ]
    );

    const submission = result.rows[0];

    // Insert scopes with risk levels
    if (scopes && Array.isArray(scopes)) {
      for (const scope of scopes) {
        const scopeDef = SCOPE_DEFINITIONS[scope] || {
          name: scope,
          riskLevel: 'medium',
          dataShared: 'Module-specific data',
        };

        await query(
          `INSERT INTO vendor_submission_scopes (
            submission_id, scope_name, risk_level, description, data_shared
          ) VALUES ($1, $2, $3, $4, $5)`,
          [submission.id, scope, scopeDef.riskLevel, scopeDef.name, scopeDef.dataShared]
        );
      }
    }

    // Log initial submission
    await query(
      `INSERT INTO vendor_submission_reviews (
        submission_id, reviewer_id, action, comments, created_at
      ) VALUES ($1, $2, $3, $4, NOW())`,
      [submission.id, null, 'submitted', 'Initial submission received', null]
    );

    logger.info('[AUDIT] Vendor submission received', {
      submission_id: submission.submission_id,
      vendor_email: vendorEmail,
      module_name: moduleName,
    });

    res.status(201).json({
      success: true,
      message: 'Module submission received successfully',
      submission: {
        submissionId: submission.submission_id,
        status: 'pending',
        submittedAt: submission.created_at,
      },
    });
  } catch (error) {
    logger.error('[ERROR] Vendor submission failed', { error: error.message });
    next(error);
  }
}

/**
 * Get vendor submission status (by submission ID - accessible to vendor)
 */
export async function getSubmissionStatus(req, res, next) {
  try {
    const { submissionId } = req.params;
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Vendor email required',
      });
    }

    const result = await query(
      `SELECT
        id, submission_id, vendor_name, module_name, status, submitted_at,
        reviewed_at, rejection_reason, admin_notes, requires_special_review
       FROM vendor_submissions
       WHERE submission_id = $1 AND vendor_email = $2`,
      [submissionId, email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found',
      });
    }

    const submission = result.rows[0];

    // Get review history
    const reviewsResult = await query(
      `SELECT action, comments, created_at, reviewer_id
       FROM vendor_submission_reviews
       WHERE submission_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [submission.id]
    );

    res.json({
      success: true,
      submission: {
        ...submission,
        reviews: reviewsResult.rows,
      },
    });
  } catch (error) {
    logger.error('[ERROR] Failed to fetch submission status', { error: error.message });
    next(error);
  }
}

/**
 * Get all vendor submissions for admin review
 */
export async function getSubmissionsForReview(req, res, next) {
  try {
    // Check if user is superadmin
    if (!req.user || !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmins can review submissions',
      });
    }

    const status = req.query.status || 'pending';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    // Count total
    const countResult = await query(
      `SELECT COUNT(*) as count FROM vendor_submissions WHERE status = $1`,
      [status]
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    // Fetch submissions
    const result = await query(
      `SELECT
        vs.*,
        COUNT(DISTINCT vss.id) as scope_count,
        COUNT(DISTINCT vsr.id) as review_count
       FROM vendor_submissions vs
       LEFT JOIN vendor_submission_scopes vss ON vss.submission_id = vs.id
       LEFT JOIN vendor_submission_reviews vsr ON vsr.submission_id = vs.id
       WHERE vs.status = $1
       GROUP BY vs.id
       ORDER BY vs.submitted_at DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );

    const submissions = await Promise.all(
      result.rows.map(async (sub) => {
        // Get scopes
        const scopesResult = await query(
          `SELECT scope_name, risk_level FROM vendor_submission_scopes
           WHERE submission_id = $1 ORDER BY risk_level DESC`,
          [sub.id]
        );

        return {
          ...sub,
          scopes: scopesResult.rows,
        };
      })
    );

    res.json({
      success: true,
      data: {
        submissions,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('[ERROR] Failed to fetch submissions for review', { error: error.message });
    next(error);
  }
}

/**
 * Get detailed submission for admin review
 */
export async function getSubmissionDetails(req, res, next) {
  try {
    if (!req.user || !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmins can review submissions',
      });
    }

    const { id } = req.params;

    const result = await query(
      `SELECT * FROM vendor_submissions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found',
      });
    }

    const submission = result.rows[0];

    // Get scopes
    const scopesResult = await query(
      `SELECT id, scope_name, risk_level, description, data_shared
       FROM vendor_submission_scopes WHERE submission_id = $1`,
      [id]
    );

    // Get review history
    const reviewsResult = await query(
      `SELECT vsr.*, u.username as reviewer_name
       FROM vendor_submission_reviews vsr
       LEFT JOIN hub_users u ON u.id = vsr.reviewer_id
       WHERE vsr.submission_id = $1
       ORDER BY vsr.created_at DESC`,
      [id]
    );

    // Get status log
    const statusLogResult = await query(
      `SELECT vsl.*, u.username as changed_by_name
       FROM vendor_submission_status_log vsl
       LEFT JOIN hub_users u ON u.id = vsl.changed_by
       WHERE vsl.submission_id = $1
       ORDER BY vsl.created_at DESC`,
      [id]
    );

    res.json({
      success: true,
      submission: {
        ...submission,
        scopes: scopesResult.rows,
        reviews: reviewsResult.rows,
        statusLog: statusLogResult.rows,
      },
    });
  } catch (error) {
    logger.error('[ERROR] Failed to fetch submission details', { error: error.message });
    next(error);
  }
}

/**
 * Review and approve vendor submission
 */
export async function approveSubmission(req, res, next) {
  try {
    if (!req.user || !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmins can approve submissions',
      });
    }

    const { id } = req.params;
    const { adminNotes, publishImmediately = false } = req.body;

    // Update submission status
    const result = await query(
      `UPDATE vendor_submissions
       SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1, admin_notes = $2
       WHERE id = $3
       RETURNING *`,
      [req.user.id, adminNotes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found',
      });
    }

    const submission = result.rows[0];

    // Log approval
    await query(
      `INSERT INTO vendor_submission_reviews (
        submission_id, reviewer_id, action, comments, created_at
      ) VALUES ($1, $2, $3, $4, NOW())`,
      [id, req.user.id, 'approved', adminNotes, null]
    );

    logger.info('[AUDIT] Vendor submission approved', {
      submission_id: submission.submission_id,
      vendor_email: submission.vendor_email,
      approved_by: req.user.username,
    });

    // Optionally publish immediately
    if (publishImmediately) {
      await publishVendorModule(submission);
    }

    res.json({
      success: true,
      message: 'Submission approved successfully',
      submission,
    });
  } catch (error) {
    logger.error('[ERROR] Failed to approve submission', { error: error.message });
    next(error);
  }
}

/**
 * Reject vendor submission
 */
export async function rejectSubmission(req, res, next) {
  try {
    if (!req.user || !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmins can reject submissions',
      });
    }

    const { id } = req.params;
    const { rejectionReason, adminNotes } = req.body;

    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required',
      });
    }

    // Update submission status
    const result = await query(
      `UPDATE vendor_submissions
       SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1,
           rejection_reason = $2, admin_notes = $3
       WHERE id = $4
       RETURNING *`,
      [req.user.id, rejectionReason, adminNotes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found',
      });
    }

    const submission = result.rows[0];

    // Log rejection
    await query(
      `INSERT INTO vendor_submission_reviews (
        submission_id, reviewer_id, action, comments, created_at
      ) VALUES ($1, $2, $3, $4, NOW())`,
      [id, req.user.id, 'rejected', rejectionReason, null]
    );

    logger.info('[AUDIT] Vendor submission rejected', {
      submission_id: submission.submission_id,
      vendor_email: submission.vendor_email,
      rejected_by: req.user.username,
      reason: rejectionReason,
    });

    res.json({
      success: true,
      message: 'Submission rejected',
      submission,
    });
  } catch (error) {
    logger.error('[ERROR] Failed to reject submission', { error: error.message });
    next(error);
  }
}

/**
 * Request more information from vendor
 */
export async function requestMoreInfo(req, res, next) {
  try {
    if (!req.user || !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmins can request info',
      });
    }

    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Information request message is required',
      });
    }

    // Update submission status
    await query(
      `UPDATE vendor_submissions
       SET status = 'under-review'
       WHERE id = $1`,
      [id]
    );

    // Log request
    await query(
      `INSERT INTO vendor_submission_reviews (
        submission_id, reviewer_id, action, comments, created_at
      ) VALUES ($1, $2, $3, $4, NOW())`,
      [id, req.user.id, 'requested_info', message, null]
    );

    logger.info('[AUDIT] Requested more info from vendor', {
      submission_id: id,
      requested_by: req.user.username,
    });

    res.json({
      success: true,
      message: 'Information request sent to vendor',
    });
  } catch (error) {
    logger.error('[ERROR] Failed to request more info', { error: error.message });
    next(error);
  }
}

/**
 * Publish approved vendor module to marketplace
 */
export async function publishModule(req, res, next) {
  try {
    if (!req.user || !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmins can publish modules',
      });
    }

    const { id } = req.params;

    // Get submission
    const result = await query(
      `SELECT * FROM vendor_submissions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found',
      });
    }

    const submission = result.rows[0];

    if (submission.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Only approved submissions can be published',
      });
    }

    // Create slug
    const moduleSlug = generateSlug(`${submission.vendor_name} ${submission.module_name}`);

    // Check if slug already exists
    const existingSlug = await query(
      `SELECT id FROM approved_vendor_modules WHERE module_slug = $1`,
      [moduleSlug]
    );

    if (existingSlug.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'A module with this name already exists',
      });
    }

    // Encrypt webhook secret
    const encryptedSecret = submission.webhook_secret
      ? decryptWebhookSecret(submission.webhook_secret)
      : null;

    // Create approved vendor module record
    const publishResult = await query(
      `INSERT INTO approved_vendor_modules (
        submission_id, vendor_name, module_name, module_slug, webhook_url,
        webhook_secret, webhook_per_community, published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        id, submission.vendor_name, submission.module_name, moduleSlug,
        submission.webhook_url, encryptedSecret, submission.webhook_per_community,
      ]
    );

    logger.info('[AUDIT] Vendor module published', {
      submission_id: submission.submission_id,
      module_slug: moduleSlug,
      published_by: req.user.username,
    });

    res.json({
      success: true,
      message: 'Module published to marketplace',
      module: publishResult.rows[0],
    });
  } catch (error) {
    logger.error('[ERROR] Failed to publish module', { error: error.message });
    next(error);
  }
}

/**
 * Get published vendor modules (marketplace)
 */
export async function getPublishedModules(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const featured = req.query.featured === 'true';

    let whereClause = 'WHERE avm.is_active = true';
    const params = [];

    if (featured) {
      whereClause += ' AND avm.is_featured = true';
    }

    // Count total
    const countResult = await query(
      `SELECT COUNT(*) as count FROM approved_vendor_modules avm ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    // Fetch modules
    const result = await query(
      `SELECT avm.*, vs.pricing_model, vs.pricing_amount, vs.pricing_currency,
              vs.module_description, vs.supported_platforms, vs.documentation_url,
              vs.support_email
       FROM approved_vendor_modules avm
       JOIN vendor_submissions vs ON vs.id = avm.submission_id
       ${whereClause}
       ORDER BY ${featured ? 'avm.feature_position ASC,' : ''} avm.published_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: {
        modules: result.rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('[ERROR] Failed to fetch published modules', { error: error.message });
    next(error);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function validateSubmission(data) {
  const errors = [];

  if (!data.vendorName || data.vendorName.trim() === '') {
    errors.push('Vendor name is required');
  }

  if (!data.vendorEmail || !isValidEmail(data.vendorEmail)) {
    errors.push('Valid vendor email is required');
  }

  if (!data.moduleName || data.moduleName.trim() === '') {
    errors.push('Module name is required');
  }

  if (!data.webhookUrl || !isValidUrl(data.webhookUrl)) {
    errors.push('Valid webhook URL is required');
  }

  if (!Array.isArray(data.scopes) || data.scopes.length === 0) {
    errors.push('At least one scope is required');
  }

  if (!PRICING_MODELS.includes(data.pricingModel)) {
    errors.push(`Pricing model must be one of: ${PRICING_MODELS.join(', ')}`);
  }

  if (typeof data.pricingAmount !== 'number' || data.pricingAmount < 0) {
    errors.push('Pricing amount must be a non-negative number');
  }

  if (!PAYMENT_METHODS.includes(data.paymentMethod)) {
    errors.push(`Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  if (!data.paymentDetails || typeof data.paymentDetails !== 'object') {
    errors.push('Payment details are required');
  }

  return errors;
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function encryptWebhookSecret(secret) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(process.env.ENCRYPTION_KEY || 'default-key'), iv);
  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptWebhookSecret(encrypted) {
  const [ivHex, data] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(process.env.ENCRYPTION_KEY || 'default-key'), iv);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function publishVendorModule(submission) {
  // TODO: Implement automated publishing if immediate publish is enabled
  return Promise.resolve();
}

function generateSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
