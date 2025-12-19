/**
 * CSRF Protection Middleware
 * Uses doubleSubmitCsrf from @anthropic/node_libs/security
 */
import { doubleSubmitCsrf } from '@anthropic/node_libs/security';
import { logger } from '../utils/logger.js';

// Re-export the CSRF utilities from node_libs
export const {
  setCsrfToken,
  verifyCsrfToken,
  refreshCsrfToken,
  getCsrfToken,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
} = doubleSubmitCsrf;

export default {
  setCsrfToken,
  verifyCsrfToken,
  refreshCsrfToken,
  getCsrfToken,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
};
