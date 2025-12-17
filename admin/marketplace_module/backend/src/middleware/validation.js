/**
 * Request Validation Middleware
 * Uses express-validator and XSS sanitization
 */
import { body, validationResult } from 'express-validator';
import xss from 'xss';
import { errors } from './errorHandler.js';

/**
 * XSS Sanitization Middleware
 * Sanitize all string inputs in request body
 */
export function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key in req.body) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = xss(req.body[key]);
      }
    }
  }
  next();
}

/**
 * Validation result handler
 * Call this after validation middleware to check for errors
 */
export function validateRequest(req, res, next) {
  const errors_list = validationResult(req);
  if (!errors_list.isEmpty()) {
    const firstError = errors_list.array()[0];
    return next(errors.badRequest(firstError.msg));
  }
  next();
}

/**
 * Common validators
 */
export const validators = {
  text: (field, { min = 0, max = 255, required = false } = {}) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .isString().withMessage(`${field} must be a string`)
      .isLength({ min, max }).withMessage(`${field} must be between ${min} and ${max} characters`)
      .trim();
  },

  integer: (field, { min, max, required = false } = {}) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    validator = validator
      .optional({ values: 'null' })
      .isInt({ min, max }).withMessage(`${field} must be an integer${min !== undefined ? ` >= ${min}` : ''}${max !== undefined ? ` <= ${max}` : ''}`);
    return validator;
  },

  positiveInteger: (field, required = false) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .isInt({ min: 0 }).withMessage(`${field} must be a positive integer`);
  },

  boolean: (field, required = false) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .isBoolean().withMessage(`${field} must be a boolean`);
  },

  url: (field, required = false) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .isURL().withMessage(`${field} must be a valid URL`);
  },

  email: (field, required = false) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .isEmail().withMessage(`${field} must be a valid email`);
  },

  jsonString: (field, required = false) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .custom((value) => {
        try {
          JSON.parse(value);
          return true;
        } catch {
          throw new Error(`${field} must be valid JSON`);
        }
      });
  },

  arrayOfStrings: (field, required = false) => {
    let validator = body(field);
    if (required) validator = validator.notEmpty().withMessage(`${field} is required`);
    return validator
      .optional({ values: 'null' })
      .isArray().withMessage(`${field} must be an array`)
      .custom((arr) => arr.every(item => typeof item === 'string'))
      .withMessage(`${field} must be an array of strings`);
  },
};

export default { sanitizeBody, validateRequest, validators };
