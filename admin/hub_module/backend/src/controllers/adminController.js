/**
 * Admin Controller - Community admin features
 */
import { query } from '../config/database.js';
import { config } from '../config/index.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

const SALT_ROUNDS = 12;

/**
 * Get community members
 */
export async function getMembers(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const role = req.query.role;

    let whereClause = 'WHERE cm.community_id = $1 AND cm.is_active = true';
    const params = [communityId];
    let paramIndex = 2;

    if (search) {
      whereClause += ` AND (cm.display_name ILIKE $${paramIndex} OR cm.platform_user_id ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (role) {
      whereClause += ` AND cm.role = $${paramIndex}`;
      params.push(role);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) as count FROM community_members cm ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const result = await query(
      `SELECT cm.id, cm.user_id, cm.display_name, cm.platform, cm.platform_user_id,
              cm.role, cm.reputation_score, cm.joined_at, cm.last_activity
       FROM community_members cm
       ${whereClause}
       ORDER BY cm.reputation_score DESC, cm.joined_at ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    const members = result.rows.map(row => ({
      id: row.id,
      odId: row.user_id,
      displayName: row.display_name,
      platform: row.platform,
      platformUserId: row.platform_user_id,
      role: row.role,
      reputationScore: row.reputation_score || 0,
      joinedAt: row.joined_at?.toISOString(),
      lastActivity: row.last_activity?.toISOString(),
    }));

    res.json({
      success: true,
      members,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update member role
 */
export async function updateMemberRole(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const userId = parseInt(req.params.userId, 10);
    const { role } = req.body;

    const validRoles = ['community-admin', 'moderator', 'member'];
    if (!validRoles.includes(role)) {
      return next(errors.badRequest('Invalid role'));
    }

    // Check target user exists and isn't owner
    const targetResult = await query(
      `SELECT role FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, userId]
    );

    if (targetResult.rows.length === 0) {
      return next(errors.notFound('Member not found'));
    }

    if (targetResult.rows[0].role === 'community-owner') {
      return next(errors.forbidden('Cannot change owner role'));
    }

    // Check permission hierarchy
    const adminRoles = ['community-owner', 'community-admin'];
    if (role === 'community-admin' && !adminRoles.includes(req.communityRole)) {
      return next(errors.forbidden('Only owners can promote to admin'));
    }

    await query(
      `UPDATE community_members SET role = $1, updated_at = NOW()
       WHERE community_id = $2 AND user_id = $3`,
      [role, communityId, userId]
    );

    logger.audit('Member role updated', {
      adminId: req.user.id,
      communityId,
      targetUserId: userId,
      newRole: role,
    });

    res.json({ success: true, message: 'Role updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Adjust member reputation
 */
export async function adjustReputation(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const userId = parseInt(req.params.userId, 10);
    const { amount, reason } = req.body;

    if (typeof amount !== 'number' || amount === 0) {
      return next(errors.badRequest('Invalid amount'));
    }

    // Update reputation
    const result = await query(
      `UPDATE community_members
       SET reputation_score = reputation_score + $1, updated_at = NOW()
       WHERE community_id = $2 AND user_id = $3
       RETURNING reputation_score`,
      [amount, communityId, userId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Member not found'));
    }

    // Log activity
    await query(
      `INSERT INTO community_activity
       (community_id, activity_type, user_id, description, metadata)
       VALUES ($1, 'reputation_adjust', $2, $3, $4)`,
      [communityId, userId, reason || 'Reputation adjusted', JSON.stringify({ amount, by: req.user.id })]
    );

    logger.audit('Reputation adjusted', {
      adminId: req.user.id,
      communityId,
      targetUserId: userId,
      amount,
      reason,
    });

    res.json({
      success: true,
      newScore: result.rows[0].reputation_score,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Remove member from community
 */
export async function removeMember(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const userId = parseInt(req.params.userId, 10);
    const { reason } = req.body;

    // Check target isn't owner
    const targetResult = await query(
      `SELECT role FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
      [communityId, userId]
    );

    if (targetResult.rows.length === 0) {
      return next(errors.notFound('Member not found'));
    }

    if (targetResult.rows[0].role === 'community-owner') {
      return next(errors.forbidden('Cannot remove owner'));
    }

    // Deactivate membership
    await query(
      `UPDATE community_members
       SET is_active = false, removed_at = NOW(), removed_by = $1, removal_reason = $2
       WHERE community_id = $3 AND user_id = $4`,
      [req.user.id, reason, communityId, userId]
    );

    // Update member count
    await query(
      `UPDATE communities SET member_count = member_count - 1 WHERE id = $1`,
      [communityId]
    );

    logger.audit('Member removed', {
      adminId: req.user.id,
      communityId,
      targetUserId: userId,
      reason,
    });

    res.json({ success: true, message: 'Member removed' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get installed modules
 */
export async function getModules(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    const result = await query(
      `SELECT mi.id, mi.module_id, m.name, m.display_name, m.description,
              m.category, mi.is_enabled, mi.config, mi.installed_at
       FROM module_installations mi
       JOIN modules m ON m.id = mi.module_id
       WHERE mi.community_id = $1
       ORDER BY m.name ASC`,
      [communityId]
    );

    const modules = result.rows.map(row => ({
      installationId: row.id,
      moduleId: row.module_id,
      name: row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      category: row.category,
      isEnabled: row.is_enabled,
      config: row.config,
      installedAt: row.installed_at?.toISOString(),
    }));

    res.json({ success: true, modules });
  } catch (err) {
    next(err);
  }
}

/**
 * Update module configuration
 */
export async function updateModuleConfig(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const moduleId = parseInt(req.params.moduleId, 10);
    const { config: moduleConfig, isEnabled } = req.body;

    const updates = [];
    const params = [communityId, moduleId];
    let paramIndex = 3;

    if (moduleConfig !== undefined) {
      updates.push(`config = $${paramIndex}`);
      params.push(JSON.stringify(moduleConfig));
      paramIndex++;
    }

    if (isEnabled !== undefined) {
      updates.push(`is_enabled = $${paramIndex}`);
      params.push(isEnabled);
      paramIndex++;
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE module_installations
       SET ${updates.join(', ')}
       WHERE community_id = $1 AND module_id = $2
       RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Module installation not found'));
    }

    logger.audit('Module config updated', {
      adminId: req.user.id,
      communityId,
      moduleId,
    });

    res.json({ success: true, message: 'Module configuration updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get browser source URLs
 */
export async function getBrowserSources(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    const result = await query(
      `SELECT source_type, token, is_active, created_at
       FROM browser_source_tokens
       WHERE community_id = $1`,
      [communityId]
    );

    const baseUrl = config.modules.browserSource || 'http://localhost:8027';
    const sources = result.rows.map(row => ({
      sourceType: row.source_type,
      url: `${baseUrl}/browser/source/${row.token}/${row.source_type}`,
      token: row.token,
      isActive: row.is_active,
      createdAt: row.created_at?.toISOString(),
    }));

    // Ensure all three types exist
    const sourceTypes = ['ticker', 'media', 'general'];
    for (const type of sourceTypes) {
      if (!sources.find(s => s.sourceType === type)) {
        // Create missing token
        const token = uuidv4().replace(/-/g, '');
        await query(
          `INSERT INTO browser_source_tokens (community_id, source_type, token)
           VALUES ($1, $2, $3)`,
          [communityId, type, token]
        );
        sources.push({
          sourceType: type,
          url: `${baseUrl}/browser/source/${token}/${type}`,
          token,
          isActive: true,
          createdAt: new Date().toISOString(),
        });
      }
    }

    res.json({ success: true, sources });
  } catch (err) {
    next(err);
  }
}

/**
 * Regenerate browser source tokens
 */
export async function regenerateBrowserSources(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { sourceType } = req.body;

    const sourceTypes = sourceType ? [sourceType] : ['ticker', 'media', 'general'];

    for (const type of sourceTypes) {
      const newToken = uuidv4().replace(/-/g, '');
      await query(
        `UPDATE browser_source_tokens
         SET token = $1, updated_at = NOW()
         WHERE community_id = $2 AND source_type = $3`,
        [newToken, communityId, type]
      );
    }

    logger.audit('Browser source tokens regenerated', {
      adminId: req.user.id,
      communityId,
      sourceTypes,
    });

    res.json({ success: true, message: 'Tokens regenerated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get custom domains
 */
export async function getDomains(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    const result = await query(
      `SELECT id, domain, is_verified, verification_token, verified_at, created_at
       FROM community_domains
       WHERE community_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [communityId]
    );

    const domains = result.rows.map(row => ({
      id: row.id,
      domain: row.domain,
      isVerified: row.is_verified,
      verificationToken: row.is_verified ? null : row.verification_token,
      verifiedAt: row.verified_at?.toISOString(),
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({ success: true, domains });
  } catch (err) {
    next(err);
  }
}

/**
 * Add custom domain
 */
export async function addDomain(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { domain } = req.body;

    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return next(errors.badRequest('Invalid domain format'));
    }

    // Check if domain already exists
    const existingResult = await query(
      `SELECT id FROM community_domains WHERE domain = $1 AND is_active = true`,
      [domain.toLowerCase()]
    );

    if (existingResult.rows.length > 0) {
      return next(errors.conflict('Domain already registered'));
    }

    // Generate verification token
    const verificationToken = `waddlebot-verify-${uuidv4()}`;

    const result = await query(
      `INSERT INTO community_domains (community_id, domain, verification_token)
       VALUES ($1, $2, $3)
       RETURNING id, domain, verification_token`,
      [communityId, domain.toLowerCase(), verificationToken]
    );

    logger.audit('Custom domain added', {
      adminId: req.user.id,
      communityId,
      domain,
    });

    res.status(201).json({
      success: true,
      domain: {
        id: result.rows[0].id,
        domain: result.rows[0].domain,
        verificationToken: result.rows[0].verification_token,
        isVerified: false,
      },
      instructions: {
        type: 'TXT',
        name: `_waddlebot.${domain}`,
        value: verificationToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Verify domain ownership via DNS
 */
export async function verifyDomain(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const domainId = parseInt(req.params.domainId, 10);

    const domainResult = await query(
      `SELECT domain, verification_token FROM community_domains
       WHERE id = $1 AND community_id = $2 AND is_active = true AND is_verified = false`,
      [domainId, communityId]
    );

    if (domainResult.rows.length === 0) {
      return next(errors.notFound('Domain not found or already verified'));
    }

    const { domain, verification_token } = domainResult.rows[0];

    // DNS lookup would happen here in production
    // For now, mark as verified if token matches
    const { resolveTxt } = await import('dns').then(m => m.promises);
    try {
      const records = await resolveTxt(`_waddlebot.${domain}`);
      const found = records.flat().includes(verification_token);

      if (!found) {
        return res.json({
          success: false,
          message: 'Verification token not found in DNS records',
        });
      }
    } catch {
      return res.json({
        success: false,
        message: 'Could not resolve DNS records. Please check your configuration.',
      });
    }

    // Mark as verified
    await query(
      `UPDATE community_domains SET is_verified = true, verified_at = NOW() WHERE id = $1`,
      [domainId]
    );

    logger.audit('Custom domain verified', {
      adminId: req.user.id,
      communityId,
      domain,
    });

    res.json({ success: true, message: 'Domain verified successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Remove custom domain
 */
export async function removeDomain(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const domainId = parseInt(req.params.domainId, 10);

    const result = await query(
      `UPDATE community_domains SET is_active = false, deactivated_at = NOW()
       WHERE id = $1 AND community_id = $2
       RETURNING domain`,
      [domainId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Domain not found'));
    }

    logger.audit('Custom domain removed', {
      adminId: req.user.id,
      communityId,
      domain: result.rows[0].domain,
    });

    res.json({ success: true, message: 'Domain removed' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get pending join requests for community
 */
export async function getJoinRequests(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const status = req.query.status || 'pending';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const countResult = await query(
      `SELECT COUNT(*) as count FROM join_requests
       WHERE community_id = $1 AND status = $2`,
      [communityId, status]
    );
    const total = parseInt(countResult.rows[0]?.count || 0, 10);

    const result = await query(
      `SELECT jr.id, jr.user_id, jr.message, jr.status, jr.created_at,
              jr.reviewed_by, jr.reviewed_at, jr.review_note,
              u.username, u.email, u.avatar_url
       FROM join_requests jr
       JOIN hub_users u ON u.id = jr.user_id
       WHERE jr.community_id = $1 AND jr.status = $2
       ORDER BY jr.created_at ASC
       LIMIT $3 OFFSET $4`,
      [communityId, status, limit, offset]
    );

    const requests = result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      email: row.email,
      avatarUrl: row.avatar_url,
      message: row.message,
      status: row.status,
      createdAt: row.created_at?.toISOString(),
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at?.toISOString(),
      reviewNote: row.review_note,
    }));

    res.json({
      success: true,
      requests,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Approve join request
 */
export async function approveJoinRequest(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const requestId = parseInt(req.params.requestId, 10);
    const { note } = req.body;

    // Get join request
    const requestResult = await query(
      `SELECT user_id FROM join_requests
       WHERE id = $1 AND community_id = $2 AND status = 'pending'`,
      [requestId, communityId]
    );

    if (requestResult.rows.length === 0) {
      return next(errors.notFound('Join request not found or already processed'));
    }

    const userId = requestResult.rows[0].user_id;

    // Update join request
    await query(
      `UPDATE join_requests
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
       WHERE id = $3`,
      [req.user.id, note || null, requestId]
    );

    // Add user as member
    await query(
      `INSERT INTO community_members (community_id, user_id, role, is_active, joined_at)
       VALUES ($1, $2, 'member', true, NOW())
       ON CONFLICT (community_id, user_id)
       DO UPDATE SET is_active = true, joined_at = NOW()`,
      [communityId, userId]
    );

    // Update member count
    await query(
      `UPDATE communities SET member_count = member_count + 1 WHERE id = $1`,
      [communityId]
    );

    logger.audit('Join request approved', {
      adminId: req.user.id,
      communityId,
      requestId,
      userId,
    });

    res.json({ success: true, message: 'Join request approved' });
  } catch (err) {
    next(err);
  }
}

/**
 * Reject join request
 */
export async function rejectJoinRequest(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const requestId = parseInt(req.params.requestId, 10);
    const { note } = req.body;

    const result = await query(
      `UPDATE join_requests
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
       WHERE id = $3 AND community_id = $4 AND status = 'pending'
       RETURNING user_id`,
      [req.user.id, note || null, requestId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Join request not found or already processed'));
    }

    logger.audit('Join request rejected', {
      adminId: req.user.id,
      communityId,
      requestId,
      userId: result.rows[0].user_id,
      reason: note,
    });

    res.json({ success: true, message: 'Join request rejected' });
  } catch (err) {
    next(err);
  }
}

/**
 * Get community settings (including join mode)
 */
export async function getCommunitySettings(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    const result = await query(
      `SELECT name, display_name, description, platform, is_public, join_mode, config
       FROM communities WHERE id = $1`,
      [communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Community not found'));
    }

    const row = result.rows[0];
    res.json({
      success: true,
      settings: {
        name: row.name,
        displayName: row.display_name,
        description: row.description,
        platform: row.platform,
        isPublic: row.is_public,
        joinMode: row.join_mode || 'open',
        config: row.config || {},
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update community settings
 */
export async function updateCommunitySettings(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { displayName, description, isPublic, joinMode, config } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (displayName !== undefined) {
      updates.push(`display_name = $${paramIndex}`);
      params.push(displayName);
      paramIndex++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(description);
      paramIndex++;
    }

    if (isPublic !== undefined) {
      updates.push(`is_public = $${paramIndex}`);
      params.push(isPublic);
      paramIndex++;
    }

    if (joinMode !== undefined) {
      const validModes = ['open', 'approval', 'invite'];
      if (!validModes.includes(joinMode)) {
        return next(errors.badRequest('Invalid join mode'));
      }
      updates.push(`join_mode = $${paramIndex}`);
      params.push(joinMode);
      paramIndex++;
    }

    if (config !== undefined) {
      updates.push(`config = $${paramIndex}`);
      params.push(JSON.stringify(config));
      paramIndex++;
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    updates.push('updated_at = NOW()');
    params.push(communityId);

    await query(
      `UPDATE communities SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      params
    );

    logger.audit('Community settings updated', {
      adminId: req.user.id,
      communityId,
      fields: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Generate temp password for user
 */
export async function generateTempPassword(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { userIdentifier, forceOAuthLink = true, expiresInHours = 24 } = req.body;

    if (!userIdentifier) {
      return next(errors.badRequest('User identifier required'));
    }

    // Generate random password
    const tempPassword = uuidv4().split('-').slice(0, 2).join('-');
    const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    await query(
      `INSERT INTO hub_temp_passwords
       (community_id, user_identifier, password_hash, expires_at, force_oauth_link, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [communityId, userIdentifier, passwordHash, expiresAt, forceOAuthLink, req.user.id]
    );

    logger.audit('Temp password generated', {
      adminId: req.user.id,
      communityId,
      userIdentifier,
    });

    res.status(201).json({
      success: true,
      tempPassword,
      expiresAt: expiresAt.toISOString(),
      instructions: `Share this password with the user. It expires in ${expiresInHours} hours and can only be used once.`,
    });
  } catch (err) {
    next(err);
  }
}

// ===== Server Linking Admin Endpoints =====

/**
 * Get linked servers for community (admin view - includes pending)
 */
export async function getLinkedServers(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const status = req.query.status; // optional filter

    let whereClause = 'WHERE cs.community_id = $1';
    const params = [communityId];

    if (status) {
      whereClause += ' AND cs.status = $2';
      params.push(status);
    }

    const result = await query(
      `SELECT cs.id, cs.platform, cs.platform_server_id, cs.platform_server_name,
              cs.link_type, cs.status, cs.is_primary, cs.config, cs.verified_at, cs.created_at,
              u1.username as added_by_username,
              u2.username as approved_by_username
       FROM community_servers cs
       LEFT JOIN hub_users u1 ON u1.id = cs.added_by
       LEFT JOIN hub_users u2 ON u2.id = cs.approved_by
       ${whereClause}
       ORDER BY cs.is_primary DESC, cs.status ASC, cs.created_at ASC`,
      params
    );

    const servers = result.rows.map(row => ({
      id: row.id,
      platform: row.platform,
      platformServerId: row.platform_server_id,
      platformServerName: row.platform_server_name,
      linkType: row.link_type,
      status: row.status,
      isPrimary: row.is_primary,
      config: row.config || {},
      verifiedAt: row.verified_at?.toISOString(),
      addedBy: row.added_by_username,
      approvedBy: row.approved_by_username,
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({ success: true, servers });
  } catch (err) {
    next(err);
  }
}

/**
 * Get pending server link requests for community
 */
export async function getServerLinkRequests(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const status = req.query.status || 'pending';

    const result = await query(
      `SELECT slr.id, slr.platform, slr.platform_server_id, slr.platform_server_name,
              slr.status, slr.review_note, slr.created_at, slr.reviewed_at,
              u1.username as requested_by_username, u1.email as requested_by_email,
              u2.username as reviewed_by_username
       FROM server_link_requests slr
       LEFT JOIN hub_users u1 ON u1.id = slr.requested_by
       LEFT JOIN hub_users u2 ON u2.id = slr.reviewed_by
       WHERE slr.community_id = $1 AND slr.status = $2
       ORDER BY slr.created_at ASC`,
      [communityId, status]
    );

    const requests = result.rows.map(row => ({
      id: row.id,
      platform: row.platform,
      platformServerId: row.platform_server_id,
      platformServerName: row.platform_server_name,
      status: row.status,
      reviewNote: row.review_note,
      requestedBy: row.requested_by_username,
      requestedByEmail: row.requested_by_email,
      reviewedBy: row.reviewed_by_username,
      createdAt: row.created_at?.toISOString(),
      reviewedAt: row.reviewed_at?.toISOString(),
    }));

    res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
}

/**
 * Approve server link request
 */
export async function approveServerLinkRequest(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const requestId = parseInt(req.params.requestId, 10);
    const { note } = req.body;

    // Get the request
    const requestResult = await query(
      `SELECT platform, platform_server_id, platform_server_name, requested_by
       FROM server_link_requests
       WHERE id = $1 AND community_id = $2 AND status = 'pending'`,
      [requestId, communityId]
    );

    if (requestResult.rows.length === 0) {
      return next(errors.notFound('Server link request not found or already processed'));
    }

    const request = requestResult.rows[0];

    // Update request status
    await query(
      `UPDATE server_link_requests
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
       WHERE id = $3`,
      [req.user.id, note || null, requestId]
    );

    // Add server to community_servers
    await query(
      `INSERT INTO community_servers
       (community_id, platform, platform_server_id, platform_server_name, added_by, approved_by, status, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', NOW())
       ON CONFLICT (community_id, platform, platform_server_id)
       DO UPDATE SET status = 'approved', approved_by = $6, verified_at = NOW()`,
      [communityId, request.platform, request.platform_server_id, request.platform_server_name, request.requested_by, req.user.id]
    );

    logger.audit('Server link request approved', {
      adminId: req.user.id,
      communityId,
      requestId,
      platform: request.platform,
      platformServerId: request.platform_server_id,
    });

    res.json({ success: true, message: 'Server link request approved' });
  } catch (err) {
    next(err);
  }
}

/**
 * Reject server link request
 */
export async function rejectServerLinkRequest(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const requestId = parseInt(req.params.requestId, 10);
    const { note } = req.body;

    const result = await query(
      `UPDATE server_link_requests
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
       WHERE id = $3 AND community_id = $4 AND status = 'pending'
       RETURNING platform, platform_server_id`,
      [req.user.id, note || null, requestId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Server link request not found or already processed'));
    }

    logger.audit('Server link request rejected', {
      adminId: req.user.id,
      communityId,
      requestId,
      platform: result.rows[0].platform,
      platformServerId: result.rows[0].platform_server_id,
      reason: note,
    });

    res.json({ success: true, message: 'Server link request rejected' });
  } catch (err) {
    next(err);
  }
}

/**
 * Remove server from community
 */
export async function removeServer(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const serverId = parseInt(req.params.serverId, 10);

    const result = await query(
      `DELETE FROM community_servers
       WHERE id = $1 AND community_id = $2
       RETURNING platform, platform_server_id, platform_server_name`,
      [serverId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Server not found'));
    }

    logger.audit('Server removed from community', {
      adminId: req.user.id,
      communityId,
      serverId,
      platform: result.rows[0].platform,
      platformServerId: result.rows[0].platform_server_id,
    });

    res.json({ success: true, message: 'Server removed from community' });
  } catch (err) {
    next(err);
  }
}

/**
 * Update server settings (e.g., set as primary)
 */
export async function updateServer(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const serverId = parseInt(req.params.serverId, 10);
    const { isPrimary, config } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (isPrimary !== undefined) {
      // If setting as primary, first unset any existing primary for this platform
      if (isPrimary) {
        const serverResult = await query(
          `SELECT platform FROM community_servers WHERE id = $1 AND community_id = $2`,
          [serverId, communityId]
        );
        if (serverResult.rows.length > 0) {
          await query(
            `UPDATE community_servers SET is_primary = false
             WHERE community_id = $1 AND platform = $2`,
            [communityId, serverResult.rows[0].platform]
          );
        }
      }
      updates.push(`is_primary = $${paramIndex}`);
      params.push(isPrimary);
      paramIndex++;
    }

    if (config !== undefined) {
      updates.push(`config = $${paramIndex}`);
      params.push(JSON.stringify(config));
      paramIndex++;
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    params.push(serverId, communityId);

    const result = await query(
      `UPDATE community_servers SET ${updates.join(', ')}
       WHERE id = $${paramIndex} AND community_id = $${paramIndex + 1}
       RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Server not found'));
    }

    logger.audit('Server settings updated', {
      adminId: req.user.id,
      communityId,
      serverId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Server settings updated' });
  } catch (err) {
    next(err);
  }
}

// ===== Mirror Group Admin Endpoints =====

/**
 * Get mirror groups for community
 */
export async function getMirrorGroups(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    const result = await query(
      `SELECT mg.id, mg.name, mg.description, mg.is_active, mg.config, mg.created_at,
              u.username as created_by_username,
              COUNT(mgm.id) as member_count
       FROM mirror_groups mg
       LEFT JOIN hub_users u ON u.id = mg.created_by
       LEFT JOIN mirror_group_members mgm ON mgm.mirror_group_id = mg.id AND mgm.is_active = true
       WHERE mg.community_id = $1
       GROUP BY mg.id, u.username
       ORDER BY mg.created_at ASC`,
      [communityId]
    );

    const groups = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      isActive: row.is_active,
      config: row.config || {},
      memberCount: parseInt(row.member_count, 10) || 0,
      createdBy: row.created_by_username,
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({ success: true, groups });
  } catch (err) {
    next(err);
  }
}

/**
 * Get single mirror group with members
 */
export async function getMirrorGroup(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const groupId = parseInt(req.params.groupId, 10);

    // Get group
    const groupResult = await query(
      `SELECT mg.id, mg.name, mg.description, mg.is_active, mg.config, mg.created_at,
              u.username as created_by_username
       FROM mirror_groups mg
       LEFT JOIN hub_users u ON u.id = mg.created_by
       WHERE mg.id = $1 AND mg.community_id = $2`,
      [groupId, communityId]
    );

    if (groupResult.rows.length === 0) {
      return next(errors.notFound('Mirror group not found'));
    }

    const group = groupResult.rows[0];

    // Get members
    const membersResult = await query(
      `SELECT mgm.id, mgm.direction, mgm.is_active, mgm.created_at,
              cs.id as server_id, cs.platform, cs.platform_server_id, cs.platform_server_name,
              csc.id as channel_id, csc.platform_channel_id, csc.platform_channel_name
       FROM mirror_group_members mgm
       JOIN community_servers cs ON cs.id = mgm.community_server_id
       LEFT JOIN community_server_channels csc ON csc.id = mgm.community_server_channel_id
       WHERE mgm.mirror_group_id = $1
       ORDER BY mgm.created_at ASC`,
      [groupId]
    );

    const members = membersResult.rows.map(row => ({
      id: row.id,
      direction: row.direction,
      isActive: row.is_active,
      server: {
        id: row.server_id,
        platform: row.platform,
        platformServerId: row.platform_server_id,
        platformServerName: row.platform_server_name,
      },
      channel: row.channel_id ? {
        id: row.channel_id,
        platformChannelId: row.platform_channel_id,
        platformChannelName: row.platform_channel_name,
      } : null,
      createdAt: row.created_at?.toISOString(),
    }));

    res.json({
      success: true,
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        isActive: group.is_active,
        config: group.config || {},
        createdBy: group.created_by_username,
        createdAt: group.created_at?.toISOString(),
        members,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Create mirror group
 */
export async function createMirrorGroup(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { name, description, config } = req.body;

    if (!name || name.trim().length === 0) {
      return next(errors.badRequest('Name is required'));
    }

    const defaultConfig = { messageTypes: ['chat'] };
    const groupConfig = config ? { ...defaultConfig, ...config } : defaultConfig;

    const result = await query(
      `INSERT INTO mirror_groups (community_id, name, description, config, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, is_active, config, created_at`,
      [communityId, name.trim(), description || null, JSON.stringify(groupConfig), req.user.id]
    );

    const row = result.rows[0];

    logger.audit('Mirror group created', {
      adminId: req.user.id,
      communityId,
      groupId: row.id,
      name: row.name,
    });

    res.status(201).json({
      success: true,
      group: {
        id: row.id,
        name: row.name,
        description: row.description,
        isActive: row.is_active,
        config: row.config,
        createdAt: row.created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update mirror group
 */
export async function updateMirrorGroup(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const groupId = parseInt(req.params.groupId, 10);
    const { name, description, config, isActive } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      params.push(name.trim());
      paramIndex++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(description);
      paramIndex++;
    }

    if (config !== undefined) {
      updates.push(`config = $${paramIndex}`);
      params.push(JSON.stringify(config));
      paramIndex++;
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      params.push(isActive);
      paramIndex++;
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    updates.push('updated_at = NOW()');
    params.push(groupId, communityId);

    const result = await query(
      `UPDATE mirror_groups SET ${updates.join(', ')}
       WHERE id = $${paramIndex} AND community_id = $${paramIndex + 1}
       RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Mirror group not found'));
    }

    logger.audit('Mirror group updated', {
      adminId: req.user.id,
      communityId,
      groupId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Mirror group updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete mirror group
 */
export async function deleteMirrorGroup(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const groupId = parseInt(req.params.groupId, 10);

    const result = await query(
      `DELETE FROM mirror_groups WHERE id = $1 AND community_id = $2 RETURNING name`,
      [groupId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Mirror group not found'));
    }

    logger.audit('Mirror group deleted', {
      adminId: req.user.id,
      communityId,
      groupId,
      name: result.rows[0].name,
    });

    res.json({ success: true, message: 'Mirror group deleted' });
  } catch (err) {
    next(err);
  }
}

/**
 * Add member to mirror group
 */
export async function addMirrorGroupMember(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const groupId = parseInt(req.params.groupId, 10);
    const { communityServerId, communityServerChannelId, direction } = req.body;

    if (!communityServerId) {
      return next(errors.badRequest('Server ID is required'));
    }

    // Validate direction
    const validDirections = ['send_only', 'receive_only', 'bidirectional'];
    const memberDirection = direction || 'bidirectional';
    if (!validDirections.includes(memberDirection)) {
      return next(errors.badRequest(`Invalid direction. Must be one of: ${validDirections.join(', ')}`));
    }

    // Verify the group belongs to this community
    const groupCheck = await query(
      `SELECT id FROM mirror_groups WHERE id = $1 AND community_id = $2`,
      [groupId, communityId]
    );

    if (groupCheck.rows.length === 0) {
      return next(errors.notFound('Mirror group not found'));
    }

    // Verify the server belongs to this community and is approved
    const serverCheck = await query(
      `SELECT id FROM community_servers WHERE id = $1 AND community_id = $2 AND status = 'approved'`,
      [communityServerId, communityId]
    );

    if (serverCheck.rows.length === 0) {
      return next(errors.badRequest('Server not found or not approved'));
    }

    // Check for existing member
    const existingCheck = await query(
      `SELECT id FROM mirror_group_members
       WHERE mirror_group_id = $1 AND community_server_id = $2
       AND (community_server_channel_id = $3 OR ($3 IS NULL AND community_server_channel_id IS NULL))`,
      [groupId, communityServerId, communityServerChannelId || null]
    );

    if (existingCheck.rows.length > 0) {
      return next(errors.conflict('This server/channel is already in the mirror group'));
    }

    const result = await query(
      `INSERT INTO mirror_group_members
       (mirror_group_id, community_server_id, community_server_channel_id, direction)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [groupId, communityServerId, communityServerChannelId || null, memberDirection]
    );

    logger.audit('Mirror group member added', {
      adminId: req.user.id,
      communityId,
      groupId,
      memberId: result.rows[0].id,
      serverId: communityServerId,
      channelId: communityServerChannelId,
    });

    res.status(201).json({ success: true, memberId: result.rows[0].id });
  } catch (err) {
    next(err);
  }
}

/**
 * Update mirror group member (direction)
 */
export async function updateMirrorGroupMember(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const groupId = parseInt(req.params.groupId, 10);
    const memberId = parseInt(req.params.memberId, 10);
    const { direction, isActive } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (direction !== undefined) {
      const validDirections = ['send_only', 'receive_only', 'bidirectional'];
      if (!validDirections.includes(direction)) {
        return next(errors.badRequest(`Invalid direction. Must be one of: ${validDirections.join(', ')}`));
      }
      updates.push(`direction = $${paramIndex}`);
      params.push(direction);
      paramIndex++;
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      params.push(isActive);
      paramIndex++;
    }

    if (updates.length === 0) {
      return next(errors.badRequest('No updates provided'));
    }

    params.push(memberId, groupId);

    // Verify group belongs to community and update member
    const result = await query(
      `UPDATE mirror_group_members mgm
       SET ${updates.join(', ')}
       FROM mirror_groups mg
       WHERE mgm.id = $${paramIndex} AND mgm.mirror_group_id = $${paramIndex + 1}
       AND mg.id = mgm.mirror_group_id AND mg.community_id = $${paramIndex + 2}
       RETURNING mgm.id`,
      [...params, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Mirror group member not found'));
    }

    logger.audit('Mirror group member updated', {
      adminId: req.user.id,
      communityId,
      groupId,
      memberId,
      updates: Object.keys(req.body),
    });

    res.json({ success: true, message: 'Member updated' });
  } catch (err) {
    next(err);
  }
}

/**
 * Remove member from mirror group
 */
export async function removeMirrorGroupMember(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const groupId = parseInt(req.params.groupId, 10);
    const memberId = parseInt(req.params.memberId, 10);

    // Verify group belongs to community and delete member
    const result = await query(
      `DELETE FROM mirror_group_members mgm
       USING mirror_groups mg
       WHERE mgm.id = $1 AND mgm.mirror_group_id = $2
       AND mg.id = mgm.mirror_group_id AND mg.community_id = $3
       RETURNING mgm.id`,
      [memberId, groupId, communityId]
    );

    if (result.rows.length === 0) {
      return next(errors.notFound('Mirror group member not found'));
    }

    logger.audit('Mirror group member removed', {
      adminId: req.user.id,
      communityId,
      groupId,
      memberId,
    });

    res.json({ success: true, message: 'Member removed' });
  } catch (err) {
    next(err);
  }
}
