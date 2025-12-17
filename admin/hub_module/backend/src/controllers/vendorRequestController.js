/**
 * Vendor Request Controller
 * Handles vendor role requests from users seeking global vendor status
 */
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Submit a vendor role request
 */
export async function submitVendorRequest(req, res, next) {
  try {
    const userId = req.user.id;
    const {
      companyName,
      companyWebsite,
      businessDescription,
      experienceSummary,
      contactEmail,
      contactPhone,
    } = req.body;

    // Validation
    if (!companyName || !businessDescription || !contactEmail) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Company Name, Business Description, and Contact Email are required',
        },
      });
    }

    // Check if user already has a pending or approved request
    const existingResult = await query(
      `SELECT id, status FROM vendor_role_requests
       WHERE user_id = $1 AND status IN ('pending', 'approved')
       ORDER BY requested_at DESC LIMIT 1`,
      [userId]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      if (existing.status === 'approved') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'ALREADY_VENDOR',
            message: 'User already has an approved vendor request',
          },
        });
      }
      return res.status(400).json({
        success: false,
        error: {
          code: 'PENDING_REQUEST',
          message: 'User already has a pending vendor request',
        },
      });
    }

    // Create vendor request
    const requestId = uuidv4();
    const insertResult = await query(
      `INSERT INTO vendor_role_requests (
        request_id, user_id, user_email, user_display_name,
        company_name, company_website, business_description, experience_summary,
        contact_email, contact_phone, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        requestId,
        userId,
        req.user.email,
        req.user.username,
        companyName,
        companyWebsite,
        businessDescription,
        experienceSummary || '',
        contactEmail,
        contactPhone || '',
        'pending',
      ]
    );

    const request = insertResult.rows[0];

    logger.info('AUDIT', {
      action: 'VENDOR_REQUEST_SUBMITTED',
      userId,
      requestId,
      companyName,
    });

    return res.status(200).json({
      success: true,
      message: 'Vendor request submitted successfully',
      request: {
        id: request.id,
        requestId: request.request_id,
        status: request.status,
        requestedAt: request.requested_at,
        companyName: request.company_name,
      },
    });
  } catch (error) {
    logger.error('ERROR', {
      action: 'VENDOR_REQUEST_SUBMIT_FAILED',
      userId: req.user?.id,
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to submit vendor request',
      },
    });
  }
}

/**
 * Get vendor request status for current user
 */
export async function getVendorRequestStatus(req, res, next) {
  try {
    const userId = req.user.id;

    const result = await query(
      `SELECT id, request_id, status, company_name, rejection_reason, requested_at, reviewed_at
       FROM vendor_role_requests
       WHERE user_id = $1
       ORDER BY requested_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        success: true,
        request: null,
      });
    }

    const request = result.rows[0];
    return res.status(200).json({
      success: true,
      request: {
        id: request.id,
        requestId: request.request_id,
        status: request.status,
        companyName: request.company_name,
        rejectionReason: request.rejection_reason,
        requestedAt: request.requested_at,
        reviewedAt: request.reviewed_at,
      },
    });
  } catch (error) {
    logger.error('ERROR', {
      action: 'GET_VENDOR_REQUEST_FAILED',
      userId: req.user?.id,
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get vendor request status',
      },
    });
  }
}

/**
 * Get all pending vendor requests (super admin only)
 */
export async function getPendingVendorRequests(req, res, next) {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params = [];

    if (status && status !== 'all') {
      whereClause += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as total FROM vendor_role_requests WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const result = await query(
      `SELECT id, request_id, user_id, user_email, user_display_name,
              company_name, business_description, experience_summary,
              contact_email, contact_phone, status, rejection_reason,
              requested_at, reviewed_at, reviewed_by, admin_notes
       FROM vendor_role_requests
       WHERE ${whereClause}
       ORDER BY requested_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      success: true,
      requests: result.rows,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('ERROR', {
      action: 'GET_PENDING_REQUESTS_FAILED',
      userId: req.user?.id,
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get pending requests',
      },
    });
  }
}

/**
 * Approve a vendor request (super admin only)
 */
export async function approveVendorRequest(req, res, next) {
  try {
    const { requestId } = req.params;
    const { adminNotes = '' } = req.body;
    const adminUserId = req.user.id;

    // Get the request
    const requestResult = await query(
      `SELECT id, user_id, status FROM vendor_role_requests WHERE request_id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Vendor request not found',
        },
      });
    }

    const vendorRequest = requestResult.rows[0];
    const targetUserId = vendorRequest.user_id;

    // Update request status
    const updateResult = await query(
      `UPDATE vendor_role_requests
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), admin_notes = $2, updated_at = NOW()
       WHERE request_id = $3
       RETURNING *`,
      [adminUserId, adminNotes, requestId]
    );

    // Grant vendor role to user
    await query(
      `UPDATE hub_users SET is_vendor = true, updated_at = NOW() WHERE id = $1`,
      [targetUserId]
    );

    logger.info('AUDIT', {
      action: 'VENDOR_REQUEST_APPROVED',
      requestId,
      targetUserId,
      adminUserId,
      adminNotes,
    });

    return res.status(200).json({
      success: true,
      message: 'Vendor request approved successfully',
      request: updateResult.rows[0],
    });
  } catch (error) {
    logger.error('ERROR', {
      action: 'APPROVE_VENDOR_REQUEST_FAILED',
      requestId: req.params.requestId,
      userId: req.user?.id,
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to approve vendor request',
      },
    });
  }
}

/**
 * Reject a vendor request (super admin only)
 */
export async function rejectVendorRequest(req, res, next) {
  try {
    const { requestId } = req.params;
    const { rejectionReason = '', adminNotes = '' } = req.body;
    const adminUserId = req.user.id;

    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Rejection reason is required',
        },
      });
    }

    // Get the request
    const requestResult = await query(
      `SELECT id, user_id FROM vendor_role_requests WHERE request_id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Vendor request not found',
        },
      });
    }

    // Update request status
    const updateResult = await query(
      `UPDATE vendor_role_requests
       SET status = 'rejected', rejection_reason = $1, reviewed_by = $2, reviewed_at = NOW(), admin_notes = $3, updated_at = NOW()
       WHERE request_id = $4
       RETURNING *`,
      [rejectionReason, adminUserId, adminNotes, requestId]
    );

    logger.info('AUDIT', {
      action: 'VENDOR_REQUEST_REJECTED',
      requestId,
      targetUserId: requestResult.rows[0].user_id,
      adminUserId,
      rejectionReason,
    });

    return res.status(200).json({
      success: true,
      message: 'Vendor request rejected successfully',
      request: updateResult.rows[0],
    });
  } catch (error) {
    logger.error('ERROR', {
      action: 'REJECT_VENDOR_REQUEST_FAILED',
      requestId: req.params.requestId,
      userId: req.user?.id,
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reject vendor request',
      },
    });
  }
}

export default {
  submitVendorRequest,
  getVendorRequestStatus,
  getPendingVendorRequests,
  approveVendorRequest,
  rejectVendorRequest,
};
