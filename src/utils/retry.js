// ============================================
// Retry Mechanism with Exponential Backoff
// Industry-standard pattern for unreliable APIs
// ============================================
const { logger } = require('./logger');

/**
 * Retry an async operation with exponential backoff
 *
 * How exponential backoff works:
 *   Attempt 1 fails → wait 1s
 *   Attempt 2 fails → wait 2s
 *   Attempt 3 fails → wait 4s
 *   Attempt 4 fails → wait 8s (capped at maxDelay)
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry configuration
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @param {number} options.baseDelay - Initial delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay cap in ms (default: 10000)
 * @param {Function} options.shouldRetry - Function to decide if error is retryable
 * @param {string} options.operationName - Name for logging
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    shouldRetry = defaultShouldRetry,
    operationName = 'operation',
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        logger.info(`✅ ${operationName} succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;

      if (attempt > maxRetries || !shouldRetry(error)) {
        logger.error(
          `❌ ${operationName} failed permanently after ${attempt} attempt(s): ${error.message}`
        );
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = delay * 0.1 * Math.random(); // 10% jitter
      const totalDelay = Math.floor(delay + jitter);

      logger.warn(
        `⚠️ ${operationName} attempt ${attempt} failed: ${error.message}. ` +
        `Retrying in ${totalDelay}ms...`
      );

      await sleep(totalDelay);
    }
  }

  throw lastError;
}

/**
 * Default retry decision logic
 * Only retry on transient/network errors, NOT on client errors (4xx)
 */
function defaultShouldRetry(error) {
  // Network errors (no response received)
  if (!error.response) return true;

  const status = error.response?.status;

  // Retry on server errors (5xx) and rate limits (429)
  if (status >= 500 || status === 429) return true;

  // Don't retry on client errors (400, 401, 403, 404, 409)
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry, defaultShouldRetry };
