/**
 * Overlay Controller
 * Manages community overlay tokens for unified browser sources
 */
import crypto from 'crypto';
import { pool } from '../config/database.js';

/**
 * Generate a secure 64-character hex key
 */
function generateOverlayKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Get or create overlay token for a community
 * GET /api/v1/admin/:communityId/overlay
 */
export async function getOverlay(req, res) {
  const { communityId } = req.params;

  try {
    // Check if overlay exists
    let result = await pool.query(
      `SELECT id, community_id, overlay_key, is_active, theme_config,
              enabled_sources, last_accessed, access_count, created_at,
              updated_at, rotated_at
       FROM community_overlay_tokens
       WHERE community_id = $1`,
      [communityId]
    );

    if (result.rows.length === 0) {
      // Create new overlay token
      const overlayKey = generateOverlayKey();
      result = await pool.query(
        `INSERT INTO community_overlay_tokens (community_id, overlay_key)
         VALUES ($1, $2)
         RETURNING id, community_id, overlay_key, is_active, theme_config,
                   enabled_sources, last_accessed, access_count, created_at,
                   updated_at, rotated_at`,
        [communityId, overlayKey]
      );
    }

    const overlay = result.rows[0];
    const baseUrl = process.env.OVERLAY_BASE_URL || 'https://overlay.waddlebot.io';

    res.json({
      success: true,
      overlay: {
        ...overlay,
        overlayUrl: `${baseUrl}/${overlay.overlay_key}`
      }
    });
  } catch (error) {
    console.error('Error getting overlay:', error);
    res.status(500).json({ success: false, error: 'Failed to get overlay' });
  }
}

/**
 * Update overlay settings
 * PUT /api/v1/admin/:communityId/overlay
 */
export async function updateOverlay(req, res) {
  const { communityId } = req.params;
  const { isActive, themeConfig, enabledSources } = req.body;

  try {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (typeof isActive === 'boolean') {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    if (themeConfig !== undefined) {
      updates.push(`theme_config = $${paramIndex++}`);
      values.push(JSON.stringify(themeConfig));
    }

    if (enabledSources !== undefined) {
      updates.push(`enabled_sources = $${paramIndex++}`);
      values.push(JSON.stringify(enabledSources));
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(communityId);

    const result = await pool.query(
      `UPDATE community_overlay_tokens
       SET ${updates.join(', ')}
       WHERE community_id = $${paramIndex}
       RETURNING id, community_id, overlay_key, is_active, theme_config,
                 enabled_sources, last_accessed, access_count, created_at,
                 updated_at, rotated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Overlay not found' });
    }

    const baseUrl = process.env.OVERLAY_BASE_URL || 'https://overlay.waddlebot.io';
    res.json({
      success: true,
      overlay: {
        ...result.rows[0],
        overlayUrl: `${baseUrl}/${result.rows[0].overlay_key}`
      }
    });
  } catch (error) {
    console.error('Error updating overlay:', error);
    res.status(500).json({ success: false, error: 'Failed to update overlay' });
  }
}

/**
 * Rotate overlay key with grace period
 * POST /api/v1/admin/:communityId/overlay/rotate
 */
export async function rotateKey(req, res) {
  const { communityId } = req.params;

  try {
    const newKey = generateOverlayKey();

    const result = await pool.query(
      `UPDATE community_overlay_tokens
       SET previous_key = overlay_key,
           overlay_key = $1,
           rotated_at = NOW(),
           updated_at = NOW()
       WHERE community_id = $2
       RETURNING id, community_id, overlay_key, is_active, theme_config,
                 enabled_sources, last_accessed, access_count, created_at,
                 updated_at, rotated_at, previous_key`,
      [newKey, communityId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Overlay not found' });
    }

    const baseUrl = process.env.OVERLAY_BASE_URL || 'https://overlay.waddlebot.io';
    res.json({
      success: true,
      message: 'Overlay key rotated. Previous key valid for 5 more minutes.',
      overlay: {
        ...result.rows[0],
        overlayUrl: `${baseUrl}/${result.rows[0].overlay_key}`
      }
    });
  } catch (error) {
    console.error('Error rotating overlay key:', error);
    res.status(500).json({ success: false, error: 'Failed to rotate key' });
  }
}

/**
 * Get overlay access statistics
 * GET /api/v1/admin/:communityId/overlay/stats
 */
export async function getOverlayStats(req, res) {
  const { communityId } = req.params;
  const days = parseInt(req.query.days) || 7;

  try {
    // Get daily access counts
    const dailyStats = await pool.query(
      `SELECT
         DATE(accessed_at) as date,
         COUNT(*) as access_count,
         COUNT(DISTINCT ip_address) as unique_ips
       FROM overlay_access_log
       WHERE community_id = $1
         AND accessed_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY DATE(accessed_at)
       ORDER BY date DESC`,
      [communityId, days]
    );

    // Get total stats
    const totalStats = await pool.query(
      `SELECT
         access_count,
         last_accessed
       FROM community_overlay_tokens
       WHERE community_id = $1`,
      [communityId]
    );

    res.json({
      success: true,
      stats: {
        total: totalStats.rows[0] || { access_count: 0, last_accessed: null },
        daily: dailyStats.rows
      }
    });
  } catch (error) {
    console.error('Error getting overlay stats:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
}
