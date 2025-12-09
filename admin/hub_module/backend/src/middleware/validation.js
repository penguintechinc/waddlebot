/**
 * Input Validation & Sanitization Middleware
 * Provides request validation and XSS protection
 */
import { body, param, query, validationResult } from 'express-validator';
import xss from 'xss';

/**
 * Sanitize user input to prevent XSS attacks
 * @param {string} input - User input to sanitize
 * @returns {string} Sanitized input
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') {
    return input;
  }

  // Use xss library with whitelist approach
  const options = {
    whiteList: {
      // Allow only safe HTML tags for rich text (if needed)
      p: [],
      br: [],
      strong: [],
      em: [],
      u: [],
      code: [],
      pre: [],
    },
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style'],
  };

  return xss(input, options);
}

/**
 * Middleware to sanitize all string fields in request body
 */
export function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    Object.keys(req.body).forEach(key => {
      if (typeof req.body[key] === 'string') {
        req.body[key] = sanitizeInput(req.body[key]);
      }
    });
  }
  next();
}

/**
 * Middleware to check validation results
 */
export function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: errors.array(),
      },
    });
  }
  next();
}

/**
 * Common validation chains
 */
export const validators = {
  // Email validation
  email: () => body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Invalid email address'),

  // Username validation
  username: () => body('username')
    .isLength({ min: 3, max: 50 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Username must be 3-50 characters and contain only letters, numbers, hyphens, and underscores'),

  // Password validation
  password: () => body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, and number'),

  // Community name validation
  communityName: () => body('name')
    .isLength({ min: 3, max: 100 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Community name must be 3-100 characters and contain only letters, numbers, hyphens, and underscores'),

  // ID parameter validation
  id: (paramName = 'id') => param(paramName)
    .isInt({ min: 1 })
    .withMessage(`${paramName} must be a positive integer`),

  // Pagination validation
  pagination: () => [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
  ],

  // Text content validation (for announcements, descriptions, etc.)
  text: (fieldName, { min = 1, max = 10000 } = {}) => body(fieldName)
    .isLength({ min, max })
    .withMessage(`${fieldName} must be between ${min} and ${max} characters`),

  // URL validation
  url: (fieldName) => body(fieldName)
    .optional()
    .isURL()
    .withMessage(`${fieldName} must be a valid URL`),

  // Boolean validation
  boolean: (fieldName) => body(fieldName)
    .optional()
    .isBoolean()
    .withMessage(`${fieldName} must be a boolean`),

  // Integer validation
  integer: (fieldName, { min, max } = {}) => {
    let validator = body(fieldName).isInt();
    if (min !== undefined) validator = validator.isInt({ min });
    if (max !== undefined) validator = validator.isInt({ max });
    return validator.withMessage(`${fieldName} must be an integer${min !== undefined ? ` >= ${min}` : ''}${max !== undefined ? ` <= ${max}` : ''}`);
  },
};

/**
 * Validation rule sets for common endpoints
 */
export const validationRules = {
  // Authentication
  login: [
    validators.email(),
    body('password').notEmpty().withMessage('Password is required'),
  ],

  register: [
    validators.email(),
    validators.username(),
    validators.password(),
  ],

  // Community creation
  createCommunity: [
    validators.communityName(),
    validators.text('display_name', { min: 3, max: 255 }),
    validators.text('description', { min: 0, max: 5000 }).optional(),
    validators.url('logo_url'),
    validators.url('banner_url'),
  ],

  // Announcement creation
  createAnnouncement: [
    validators.text('title', { min: 3, max: 255 }),
    validators.text('content', { min: 1, max: 10000 }),
    body('announcement_type')
      .optional()
      .isIn(['general', 'event', 'maintenance', 'update'])
      .withMessage('Invalid announcement type'),
    validators.integer('priority', { min: 0, max: 10 }),
    validators.boolean('is_pinned'),
    validators.boolean('broadcast_to_platforms'),
  ],

  // Pagination
  pagination: validators.pagination(),
};

export default {
  sanitizeInput,
  sanitizeBody,
  validateRequest,
  validators,
  validationRules,
};
