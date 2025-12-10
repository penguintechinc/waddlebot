/**
 * Cookie Consent Middleware
 * Enforces cookie consent requirements for GDPR compliance
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { errors } from './errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Check if user has consented to required cookie category
 * Usage: app.use('/analytics', checkCookieConsent('analytics'))
 */
export function checkCookieConsent(requiredCategory = 'functional') {
  return async (req, res, next) => {
    try {
      // Essential cookies always allowed
      if (requiredCategory === 'necessary') {
        return next();
      }

      const userId = req.user?.id || null;
      const consentId = req.cookies?.waddlebot_consent_id || null;

      // If no user and no consent cookie, block non-essential
      if (!userId && !consentId) {
        logger.audit('CONSENT_BLOCKED', {
          reason: 'no_consent_id',
          category: requiredCategory,
          path: req.path,
          ip: req.ip,
        });

        return next(errors.forbidden(
          `Consent required for ${requiredCategory} cookies`
        ));
      }

      // Get consent preferences
      const consentResult = userId
        ? await query(
            `SELECT preferences FROM cookie_consent
             WHERE user_id = $1
             ORDER BY updated_at DESC LIMIT 1`,
            [userId]
          )
        : await query(
            `SELECT preferences FROM cookie_consent
             WHERE consent_id = $1
             ORDER BY updated_at DESC LIMIT 1`,
            [consentId]
          );

      if (consentResult.rows.length === 0) {
        logger.audit('CONSENT_BLOCKED', {
          reason: 'no_consent_record',
          category: requiredCategory,
          userId,
          consentId,
          path: req.path,
        });

        return next(errors.forbidden(
          `Consent required for ${requiredCategory} cookies`
        ));
      }

      const preferences = typeof consentResult.rows[0].preferences === 'string'
        ? JSON.parse(consentResult.rows[0].preferences)
        : consentResult.rows[0].preferences;

      // Check if required category is accepted
      if (!preferences[requiredCategory]) {
        logger.audit('CONSENT_BLOCKED', {
          reason: 'category_not_consented',
          category: requiredCategory,
          userId,
          consentId,
          path: req.path,
        });

        return next(errors.forbidden(
          `User has not consented to ${requiredCategory} cookies`
        ));
      }

      // Consent granted, proceed
      req.consentId = consentId;
      req.hasConsent = {
        [requiredCategory]: true,
      };

      next();
    } catch (err) {
      logger.error('Error checking consent', { error: err.message });
      next(err);
    }
  };
}

/**
 * Attach consent ID to request for anonymous users
 * Generates or retrieves existing consent ID
 */
export async function attachConsentId(req, res, next) {
  try {
    let consentId = req.cookies?.waddlebot_consent_id;

    if (!consentId) {
      consentId = uuidv4();

      // Set consent ID cookie
      res.cookie('waddlebot_consent_id', consentId, {
        maxAge: 365 * 24 * 60 * 60 * 1000, // 12 months
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
        httpOnly: false,
      });
    }

    req.consentId = consentId;
    next();
  } catch (err) {
    logger.error('Error attaching consent ID', { error: err.message });
    next(err);
  }
}

/**
 * Get user's current consent preferences
 * Attached to req.preferences
 */
export async function loadConsentPreferences(req, res, next) {
  try {
    const userId = req.user?.id || null;
    const consentId = req.cookies?.waddlebot_consent_id || null;

    let preferences = null;

    if (userId) {
      const result = await query(
        `SELECT preferences FROM cookie_consent
         WHERE user_id = $1
         ORDER BY updated_at DESC LIMIT 1`,
        [userId]
      );

      if (result.rows.length > 0) {
        preferences = typeof result.rows[0].preferences === 'string'
          ? JSON.parse(result.rows[0].preferences)
          : result.rows[0].preferences;
      }
    } else if (consentId) {
      const result = await query(
        `SELECT preferences FROM cookie_consent
         WHERE consent_id = $1
         ORDER BY updated_at DESC LIMIT 1`,
        [consentId]
      );

      if (result.rows.length > 0) {
        preferences = typeof result.rows[0].preferences === 'string'
          ? JSON.parse(result.rows[0].preferences)
          : result.rows[0].preferences;
      }
    }

    // Default: only necessary cookies
    req.consentPreferences = preferences || {
      necessary: true,
      functional: false,
      analytics: false,
      marketing: false,
    };

    next();
  } catch (err) {
    logger.error('Error loading consent preferences', { error: err.message });
    // Continue even if consent loading fails - don't block requests
    next();
  }
}

/**
 * Validate consent before setting sensitive cookies
 * Used for analytics, tracking, or third-party cookies
 */
export async function validateCookieUsage(cookieName, requiredCategory) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id || null;
      const consentId = req.cookies?.waddlebot_consent_id || null;

      // Check if consent is valid
      const hasConsent = userId || consentId;
      if (!hasConsent) {
        logger.audit('COOKIE_USAGE_BLOCKED', {
          cookie: cookieName,
          category: requiredCategory,
          reason: 'no_consent',
        });
        return next(errors.forbidden('Consent required'));
      }

      // Get preferences
      const consentResult = userId
        ? await query(
            `SELECT preferences FROM cookie_consent
             WHERE user_id = $1
             ORDER BY updated_at DESC LIMIT 1`,
            [userId]
          )
        : await query(
            `SELECT preferences FROM cookie_consent
             WHERE consent_id = $1
             ORDER BY updated_at DESC LIMIT 1`,
            [consentId]
          );

      if (consentResult.rows.length === 0) {
        logger.audit('COOKIE_USAGE_BLOCKED', {
          cookie: cookieName,
          category: requiredCategory,
          reason: 'no_record',
        });
        return next(errors.forbidden('Consent record not found'));
      }

      const preferences = typeof consentResult.rows[0].preferences === 'string'
        ? JSON.parse(consentResult.rows[0].preferences)
        : consentResult.rows[0].preferences;

      // Block if category not consented
      if (!preferences[requiredCategory]) {
        logger.audit('COOKIE_USAGE_BLOCKED', {
          cookie: cookieName,
          category: requiredCategory,
          reason: 'category_denied',
          userId,
          consentId,
        });
        return next(errors.forbidden(
          `${cookieName} requires ${requiredCategory} cookie consent`
        ));
      }

      next();
    } catch (err) {
      logger.error('Error validating cookie usage', { error: err.message });
      next(err);
    }
  };
}

export default {
  checkCookieConsent,
  attachConsentId,
  loadConsentPreferences,
  validateCookieUsage,
};
