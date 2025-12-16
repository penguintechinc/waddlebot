/**
 * Custom Error Utilities
 */

export class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
  }
}

export function badRequest(message) {
  return new ApiError(400, message);
}

export function unauthorized(message) {
  return new ApiError(401, message);
}

export function forbidden(message) {
  return new ApiError(403, message);
}

export function notFound(message) {
  return new ApiError(404, message);
}

export function conflict(message) {
  return new ApiError(409, message);
}

export function internalServer(message) {
  return new ApiError(500, message);
}
