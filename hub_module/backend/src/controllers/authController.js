/**
 * Auth Controller - OAuth and temp password authentication
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { query, transaction } from '../config/database.js';
import { config } from '../config/index.js';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const SALT_ROUNDS = 12;

/**
 * Local admin login
 */
export async function adminLogin(req, res, next) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return next(errors.badRequest('Username and password required'));
    }

    // Find admin user
    const result = await query(
      `SELECT id, username, password_hash, email, is_active, is_super_admin
       FROM hub_admins
       WHERE username = $1 AND is_active = true`,
      [username]
    );

    if (result.rows.length === 0) {
      logger.auth('Admin login failed - user not found', { username });
      return next(errors.unauthorized('Invalid credentials'));
    }

    const admin = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      logger.auth('Admin login failed - invalid password', { username });
      return next(errors.unauthorized('Invalid credentials'));
    }

    // Update last login
    await query(
      'UPDATE hub_admins SET last_login = NOW() WHERE id = $1',
      [admin.id]
    );

    // Create session
    const sessionToken = await createSession({
      platform: 'admin',
      platformUserId: admin.id.toString(),
      username: admin.username,
      isAdmin: true,
      isSuperAdmin: admin.is_super_admin,
    });

    logger.auth('Admin login successful', { username, isSuperAdmin: admin.is_super_admin });

    res.json({
      success: true,
      token: sessionToken,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        isAdmin: true,
        isSuperAdmin: admin.is_super_admin,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Start OAuth flow - redirect to identity module
 */
export async function startOAuth(req, res, next) {
  try {
    const { platform } = req.params;
    const validPlatforms = ['discord', 'twitch', 'slack'];

    if (!validPlatforms.includes(platform)) {
      return next(errors.badRequest('Invalid platform'));
    }

    const state = uuidv4();
    const redirectUri = `${config.identity.callbackBaseUrl}/api/v1/auth/oauth/${platform}/callback`;

    // Get OAuth URL from Identity Core
    const response = await axios.get(
      `${config.identity.apiUrl}/auth/oauth/${platform}/authorize`,
      { params: { redirect_uri: redirectUri, state } }
    );

    logger.auth('OAuth flow started', { platform, state });
    res.json({ success: true, authorizeUrl: response.data.authorize_url, state });
  } catch (err) {
    logger.error('OAuth start error', { error: err.message });
    next(err);
  }
}

/**
 * OAuth callback - exchange code for user info
 */
export async function oauthCallback(req, res, next) {
  try {
    const { platform } = req.params;
    const { code, state } = req.query;

    if (!code) {
      return next(errors.badRequest('Missing authorization code'));
    }

    const redirectUri = `${config.identity.callbackBaseUrl}/api/v1/auth/oauth/${platform}/callback`;

    // Exchange code with Identity Core
    const response = await axios.post(
      `${config.identity.apiUrl}/auth/oauth/${platform}/callback`,
      { code, redirect_uri: redirectUri, state }
    );

    const userData = response.data.user;

    // Create or update user session
    const sessionToken = await createSession({
      platform,
      platformUserId: userData.id,
      username: userData.username,
      avatarUrl: userData.avatar_url,
    });

    logger.auth('OAuth login successful', { platform, userId: userData.id });

    // Redirect to frontend with token
    res.redirect(`${config.cors.origin}/auth/callback?token=${sessionToken}`);
  } catch (err) {
    logger.error('OAuth callback error', { error: err.message });
    res.redirect(`${config.cors.origin}/login?error=oauth_failed`);
  }
}

/**
 * Temp password login
 */
export async function tempPasswordLogin(req, res, next) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return next(errors.badRequest('Identifier and password required'));
    }

    // Find temp password entry
    const result = await query(
      `SELECT * FROM hub_temp_passwords
       WHERE user_identifier = $1 AND is_used = false AND expires_at > NOW()`,
      [identifier]
    );

    if (result.rows.length === 0) {
      logger.auth('Temp password login failed - not found', { identifier });
      return next(errors.unauthorized('Invalid credentials or expired'));
    }

    const tempPw = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, tempPw.password_hash);
    if (!valid) {
      logger.auth('Temp password login failed - invalid password', { identifier });
      return next(errors.unauthorized('Invalid credentials'));
    }

    // Mark as used
    await query(
      'UPDATE hub_temp_passwords SET is_used = true, used_at = NOW() WHERE id = $1',
      [tempPw.id]
    );

    // Create session with pending OAuth link
    const sessionToken = await createSession({
      platform: 'temp',
      platformUserId: tempPw.id.toString(),
      username: identifier,
      requiresOAuthLink: tempPw.force_oauth_link,
      communityId: tempPw.community_id,
    });

    logger.auth('Temp password login successful', { identifier });

    res.json({
      success: true,
      token: sessionToken,
      requiresOAuthLink: tempPw.force_oauth_link,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Link OAuth account after temp password login
 */
export async function linkOAuth(req, res, next) {
  try {
    if (!req.user) {
      return next(errors.unauthorized());
    }

    const { platform, platformUserId, username } = req.body;

    if (!platform || !platformUserId) {
      return next(errors.badRequest('Platform and platformUserId required'));
    }

    // Update temp password record with linked OAuth
    await query(
      `UPDATE hub_temp_passwords
       SET linked_oauth_platform = $1, linked_oauth_user_id = $2
       WHERE id = $3`,
      [platform, platformUserId, req.user.platformUserId]
    );

    // Create new session with OAuth identity
    const sessionToken = await createSession({
      platform,
      platformUserId,
      username,
    });

    logger.auth('OAuth linked to temp account', { platform, platformUserId });

    res.json({ success: true, token: sessionToken });
  } catch (err) {
    next(err);
  }
}

/**
 * Refresh JWT token
 */
export async function refreshToken(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;

    if (!token) {
      return next(errors.badRequest('Token required'));
    }

    // Verify current token
    const decoded = jwt.verify(token, config.jwt.secret, { ignoreExpiration: true });

    // Check if session exists and is active
    const result = await query(
      'SELECT * FROM hub_sessions WHERE session_token = $1 AND is_active = true',
      [token]
    );

    if (result.rows.length === 0) {
      return next(errors.unauthorized('Invalid session'));
    }

    // Create new token
    const newToken = await createSession({
      platform: decoded.platform,
      platformUserId: decoded.platformUserId,
      username: decoded.username,
      avatarUrl: decoded.avatarUrl,
    });

    // Invalidate old token
    await query(
      'UPDATE hub_sessions SET is_active = false, revoked_at = NOW() WHERE session_token = $1',
      [token]
    );

    res.json({ success: true, token: newToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return next(errors.unauthorized('Invalid token'));
    }
    next(err);
  }
}

/**
 * Logout - invalidate session
 */
export async function logout(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      await query(
        'UPDATE hub_sessions SET is_active = false, revoked_at = NOW() WHERE session_token = $1',
        [token]
      );
      logger.auth('User logged out');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Get current user info
 */
export async function getCurrentUser(req, res, next) {
  try {
    if (!req.user) {
      return res.json({ success: true, user: null });
    }

    // Get user's communities
    const communitiesResult = await query(
      `SELECT c.id, c.name, c.display_name, cm.role
       FROM community_members cm
       JOIN communities c ON c.id = cm.community_id
       WHERE cm.user_id = $1 AND cm.is_active = true AND c.is_active = true`,
      [req.user.id]
    );

    res.json({
      success: true,
      user: {
        id: req.user.id,
        platform: req.user.platform,
        platformUserId: req.user.platformUserId,
        username: req.user.username,
        avatarUrl: req.user.avatarUrl,
        roles: req.user.roles,
        communities: communitiesResult.rows.map(r => ({
          id: r.id,
          name: r.name,
          displayName: r.display_name || r.name,
          role: r.role,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Create session and JWT token
 */
async function createSession({ platform, platformUserId, username, avatarUrl, requiresOAuthLink, communityId, isAdmin, isSuperAdmin }) {
  // Look up or create user ID
  let userId = null;

  if (platform !== 'temp' && platform !== 'admin') {
    // Check if user exists by platform identity
    const userResult = await query(
      `SELECT id FROM community_members WHERE platform = $1 AND platform_user_id = $2 LIMIT 1`,
      [platform, platformUserId]
    );
    userId = userResult.rows[0]?.id;
  }

  // Build roles array
  const roles = [];
  if (isAdmin) roles.push('admin');
  if (isSuperAdmin) roles.push('super_admin');

  // Create JWT payload
  const payload = {
    userId,
    platform,
    platformUserId,
    username,
    avatarUrl,
    requiresOAuthLink: requiresOAuthLink || false,
    communityId,
    isAdmin: isAdmin || false,
    isSuperAdmin: isSuperAdmin || false,
    roles,
  };

  // Generate token
  const token = jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });

  // Store session
  const expiresAt = new Date(Date.now() + config.jwt.expiresIn * 1000);

  await query(
    `INSERT INTO hub_sessions
     (session_token, user_id, platform, platform_user_id, platform_username, avatar_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, userId, platform, platformUserId, username, avatarUrl, expiresAt]
  );

  return token;
}
