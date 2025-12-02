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
