/**
 * Announcement Controller - Community announcement management
 * Handles creating, updating, retrieving, and broadcasting announcements.
 */
import { query } from '../config/database.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import * as broadcastService from '../services/broadcastService.js';
      communityId,
      announcementId,
      userId: req.user.userId,
      username: req.user.username,
      platforms,
      results: broadcastResults,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get broadcast status for an announcement
 * GET /api/v1/communities/:communityId/announcements/:announcementId/broadcast-status
 */
export async function getBroadcastStatus(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const announcementId = parseInt(req.params.announcementId, 10);

    // Verify announcement exists
    const announcementResult = await query(
      `SELECT id FROM announcements WHERE id = $1 AND community_id = $2`,
      [announcementId, communityId]
    );

    if (announcementResult.rows.length === 0) {
      return next(errors.notFound('Announcement not found'));
    }

    // Get broadcast records
    const result = await query(
      `SELECT id, announcement_id, platform, status, broadcast_at,
              completed_at, error_message
       FROM announcement_broadcasts
       WHERE announcement_id = $1
       ORDER BY broadcast_at DESC`,
      [announcementId]
    );

    const broadcasts = result.rows.map(row => ({
      id: row.id,
      announcementId: row.announcement_id,
      platform: row.platform,
      status: row.status,
      broadcastAt: row.broadcast_at?.toISOString(),
      completedAt: row.completed_at?.toISOString(),
      errorMessage: row.error_message,
    }));

    res.json({
      success: true,
      data: broadcasts,
    });
  } catch (err) {
    next(err);
  }
}

// Helper functions

/**
 * Format announcement row from database
 */
function formatAnnouncement(row) {
  if (!row) return null;

  return {
    id: row.id,
    communityId: row.community_id,
    title: row.title,
    content: row.content,
    announcementType: row.announcement_type,
    status: row.status,
    isPinned: row.is_pinned,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at?.toISOString(),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at?.toISOString(),
    publishedAt: row.published_at?.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
}

export default {
  getAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  publishAnnouncement,
  pinAnnouncement,
  unpinAnnouncement,
  archiveAnnouncement,
  broadcastAnnouncement,
  getBroadcastStatus,
};
