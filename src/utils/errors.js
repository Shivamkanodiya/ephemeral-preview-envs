// ============================================
// Custom Error Classes
// Structured error hierarchy for clean handling
// ============================================

/**
 * Base application error
 * All custom errors extend this
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true; // Operational vs programmer errors
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when a Render API call fails
 */
class RenderAPIError extends AppError {
  constructor(message, renderStatus, renderResponse) {
    super(message, 502, 'RENDER_API_ERROR');
    this.renderStatus = renderStatus;
    this.renderResponse = renderResponse;
  }
}

/**
 * Thrown when webhook signature verification fails
 */
class WebhookAuthError extends AppError {
  constructor(message = 'Invalid webhook signature') {
    super(message, 401, 'WEBHOOK_AUTH_ERROR');
  }
}

/**
 * Thrown when a preview service is not found
 */
class PreviewNotFoundError extends AppError {
  constructor(prNumber) {
    super(`Preview for PR #${prNumber} not found`, 404, 'PREVIEW_NOT_FOUND');
    this.prNumber = prNumber;
  }
}

/**
 * Thrown when free-tier limits are reached
 */
class QuotaExceededError extends AppError {
  constructor(message = 'Free tier service limit reached') {
    super(message, 429, 'QUOTA_EXCEEDED');
  }
}

/**
 * Thrown for invalid input/request data
 */
class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

module.exports = {
  AppError,
  RenderAPIError,
  WebhookAuthError,
  PreviewNotFoundError,
  QuotaExceededError,
  ValidationError,
};
