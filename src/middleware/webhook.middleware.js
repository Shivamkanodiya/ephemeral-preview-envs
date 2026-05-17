// ============================================
// Webhook Signature Verification Middleware
// Validates that incoming webhooks are from GitHub
// ============================================
const githubService = require('../services/github.service');
const { logger } = require('../utils/logger');

function verifyGitHubWebhook(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody;

  if (!rawBody) {
    logger.warn('Missing raw body for webhook verification');
    return res.status(400).json({ error: 'Missing request body' });
  }

  const isValid = githubService.verifyWebhookSignature(rawBody, signature);

  if (!isValid) {
    logger.warn('❌ Invalid webhook signature received');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  logger.debug('✅ Webhook signature verified');
  next();
}

module.exports = { verifyGitHubWebhook };
