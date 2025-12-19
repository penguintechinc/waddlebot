/**
 * Ticket Controller - Proxy requests to calendar module for ticketing operations
 * Handles ticket management, check-in, QR verification, and attendance tracking
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Get calendar module URL from environment
const CALENDAR_API_URL = process.env.CALENDAR_API_URL || 'http://calendar-interaction:8038';

/**
 * Helper function to proxy requests to calendar module
 */
async function proxyToCalendar(path, options = {}) {
  try {
    const url = `${CALENDAR_API_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.serviceApiKey,
        ...options.headers,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.error || data.message || 'Calendar module request failed');
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (err) {
    logger.error('Calendar module proxy error', {
      path,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Build user context header from request
 */
function buildUserContext(req) {
  return JSON.stringify({
    user_id: req.user?.id,
    username: req.user?.username,
    platform: 'hub',
    platform_user_id: String(req.user?.id || 'anonymous'),
    role: req.user?.isSuperAdmin ? 'super_admin' : 'admin',
  });
}

// ===== Ticket Types Management =====

/**
 * List ticket types for an event
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/ticket-types
 */
export async function listTicketTypes(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/ticket-types`,
      {
        method: 'GET',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Create a ticket type for an event
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/ticket-types
 */
export async function createTicketType(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/ticket-types`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticket type created', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketTypeName: req.body.name,
    });

    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Update a ticket type
 * PUT /api/v1/admin/:communityId/calendar/events/:eventId/ticket-types/:typeId
 */
export async function updateTicketType(req, res, next) {
  try {
    const { communityId, eventId, typeId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/ticket-types/${typeId}`,
      {
        method: 'PUT',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticket type updated', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketTypeId: parseInt(typeId, 10),
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Delete a ticket type
 * DELETE /api/v1/admin/:communityId/calendar/events/:eventId/ticket-types/:typeId
 */
export async function deleteTicketType(req, res, next) {
  try {
    const { communityId, eventId, typeId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/ticket-types/${typeId}`,
      {
        method: 'DELETE',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticket type deleted', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketTypeId: parseInt(typeId, 10),
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ===== Ticket Management =====

/**
 * List tickets for an event
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/tickets
 */
export async function listTickets(req, res, next) {
  try {
    const { communityId, eventId } = req.params;
    const queryParams = new URLSearchParams();

    if (req.query.status) queryParams.set('status', req.query.status);
    if (req.query.is_checked_in !== undefined) queryParams.set('is_checked_in', req.query.is_checked_in);
    if (req.query.ticket_type_id) queryParams.set('ticket_type_id', req.query.ticket_type_id);
    if (req.query.search) queryParams.set('search', req.query.search);
    if (req.query.limit) queryParams.set('limit', req.query.limit);
    if (req.query.offset) queryParams.set('offset', req.query.offset);

    const queryString = queryParams.toString();
    const path = `/api/v1/calendar/${communityId}/events/${eventId}/tickets${queryString ? `?${queryString}` : ''}`;

    const data = await proxyToCalendar(path, {
      method: 'GET',
      headers: { 'X-User-Context': buildUserContext(req) },
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Create a ticket manually (admin operation)
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/tickets
 */
export async function createTicket(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/tickets`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticket created manually', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      holderUsername: req.body.username,
    });

    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Get a specific ticket
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/tickets/:ticketId
 */
export async function getTicket(req, res, next) {
  try {
    const { communityId, eventId, ticketId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/tickets/${ticketId}`,
      {
        method: 'GET',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Cancel a ticket
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/tickets/:ticketId/cancel
 */
export async function cancelTicket(req, res, next) {
  try {
    const { communityId, eventId, ticketId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/tickets/${ticketId}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticket cancelled', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketId: parseInt(ticketId, 10),
      reason: req.body.reason,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Transfer a ticket to another user
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/tickets/:ticketId/transfer
 */
export async function transferTicket(req, res, next) {
  try {
    const { communityId, eventId, ticketId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/tickets/${ticketId}/transfer`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticket transferred', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketId: parseInt(ticketId, 10),
      newHolder: req.body.username,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ===== Check-in Operations =====

/**
 * Verify a ticket by QR code (64-char hex)
 * POST /api/v1/calendar/verify-ticket
 */
export async function verifyTicket(req, res, next) {
  try {
    const data = await proxyToCalendar('/api/v1/calendar/verify-ticket', {
      method: 'POST',
      body: JSON.stringify({
        ...req.body,
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
      }),
      headers: { 'X-User-Context': buildUserContext(req) },
    });

    // Log check-in attempts (both success and failure)
    logger.audit('Ticket verification attempted', {
      adminId: req.user?.id,
      ticketCode: req.body.ticket_code?.substring(0, 8) + '...',
      success: data.success,
      resultCode: data.result_code,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Manual check-in by ticket ID
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/check-in
 */
export async function checkIn(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/check-in`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...req.body,
          ip_address: req.ip,
          user_agent: req.get('User-Agent'),
        }),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Manual check-in performed', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketId: req.body.ticket_id,
      success: data.success,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Undo a check-in
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/tickets/:ticketId/undo-check-in
 */
export async function undoCheckIn(req, res, next) {
  try {
    const { communityId, eventId, ticketId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/tickets/${ticketId}/undo-check-in`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Check-in undone', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      ticketId: parseInt(ticketId, 10),
      reason: req.body.reason,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ===== Attendance & Reporting =====

/**
 * Get attendance statistics for an event
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/attendance
 */
export async function getAttendanceStats(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/attendance`,
      {
        method: 'GET',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Get check-in audit log for an event
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/check-in-log
 */
export async function getCheckInLog(req, res, next) {
  try {
    const { communityId, eventId } = req.params;
    const queryParams = new URLSearchParams();

    if (req.query.limit) queryParams.set('limit', req.query.limit);
    if (req.query.offset) queryParams.set('offset', req.query.offset);
    if (req.query.success_only) queryParams.set('success_only', req.query.success_only);

    const queryString = queryParams.toString();
    const path = `/api/v1/calendar/${communityId}/events/${eventId}/check-in-log${queryString ? `?${queryString}` : ''}`;

    const data = await proxyToCalendar(path, {
      method: 'GET',
      headers: { 'X-User-Context': buildUserContext(req) },
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Export attendance data (CSV/JSON)
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/attendance/export
 */
export async function exportAttendance(req, res, next) {
  try {
    const { communityId, eventId } = req.params;
    const format = req.query.format || 'json';

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/attendance/export?format=${format}`,
      {
        method: 'GET',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Attendance exported', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      format,
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=attendance-${eventId}.csv`);
      res.send(data);
    } else {
      res.json(data);
    }
  } catch (err) {
    next(err);
  }
}

// ===== Event Admin Management =====

/**
 * List event admins for an event
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/admins
 */
export async function listEventAdmins(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/admins`,
      {
        method: 'GET',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Assign an event admin
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/admins
 */
export async function assignEventAdmin(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/admins`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Event admin assigned', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      assignedUsername: req.body.username,
    });

    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Update event admin permissions
 * PUT /api/v1/admin/:communityId/calendar/events/:eventId/admins/:adminId
 */
export async function updateEventAdmin(req, res, next) {
  try {
    const { communityId, eventId, adminId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/admins/${adminId}`,
      {
        method: 'PUT',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Event admin permissions updated', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      eventAdminId: parseInt(adminId, 10),
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Revoke event admin access
 * DELETE /api/v1/admin/:communityId/calendar/events/:eventId/admins/:adminId
 */
export async function revokeEventAdmin(req, res, next) {
  try {
    const { communityId, eventId, adminId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/admins/${adminId}`,
      {
        method: 'DELETE',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Event admin revoked', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      eventAdminId: parseInt(adminId, 10),
      reason: req.body?.reason,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Get current user's permissions for an event
 * GET /api/v1/admin/:communityId/calendar/events/:eventId/my-permissions
 */
export async function getMyPermissions(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/my-permissions`,
      {
        method: 'GET',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ===== Ticketing Configuration =====

/**
 * Enable ticketing for an event
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/ticketing/enable
 */
export async function enableTicketing(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/ticketing/enable`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticketing enabled for event', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
      config: req.body,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * Disable ticketing for an event
 * POST /api/v1/admin/:communityId/calendar/events/:eventId/ticketing/disable
 */
export async function disableTicketing(req, res, next) {
  try {
    const { communityId, eventId } = req.params;

    const data = await proxyToCalendar(
      `/api/v1/calendar/${communityId}/events/${eventId}/ticketing/disable`,
      {
        method: 'POST',
        headers: { 'X-User-Context': buildUserContext(req) },
      }
    );

    logger.audit('Ticketing disabled for event', {
      adminId: req.user.id,
      communityId: parseInt(communityId, 10),
      eventId: parseInt(eventId, 10),
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
}
