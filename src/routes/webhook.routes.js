// ============================================
// Webhook Routes (P0 Fix #1 — Async Processing)
// ============================================
//
// CRITICAL DESIGN:
// GitHub's webhook delivery timeout is 10 seconds.
// Our controller makes 4-5 external API calls (Render + GitHub)
// which easily exceed 10s. If we block:
//   1. GitHub marks delivery failed
//   2. GitHub retries the same webhook
//   3. We process the same event multiple times
//   4. Duplicate Render services, duplicate PR comments
//
// FIX: Respond 202 Accepted IMMEDIATELY.
// Process the webhook asynchronously via setImmediate().
// GitHub sees 202, marks delivery successful, never retries.
//
// This is how production webhook receivers work:
//   Shopify, Stripe, Twilio — all respond 2xx first,
//   then process in background.
// ============================================
const express = require('express');
const router = express.Router();
const { verifyGitHubWebhook } = require('../middleware/webhook.middleware');
const previewController = require('../controllers/preview.controller');
const { isDuplicateDelivery, markDeliveryProcessed } = require('../store/delivery.store');
const { logger } = require('../utils/logger');

/**
 * POST /api/webhooks/github
 *
 * Validates signature → dedup check → responds 202 immediately →
 * processes asynchronously in the background.
 */
router.post('/github', verifyGitHubWebhook, async (req, res) => {
  const event = req.headers['x-github-event'];
  const action = req.body.action;
  const delivery = req.headers['x-github-delivery'];

  logger.info(`📩 Webhook received: event=${event} action=${action} delivery=${delivery}`);

  // ── Ignore non-PR events synchronously ──────────────────────
  if (event !== 'pull_request') {
    return res.status(200).json({
      message: `Ignored event: ${event}`,
      hint: 'Only pull_request events are processed',
    });
  }

  // ── Validate payload synchronously ──────────────────────────
  if (!req.body.pull_request || !req.body.repository) {
    return res.status(400).json({ error: 'Invalid PR payload structure' });
  }

  // ── Ignore unknown actions synchronously ────────────────────
  const supportedActions = ['opened', 'reopened', 'synchronize', 'closed'];
  if (!supportedActions.includes(action)) {
    return res.status(200).json({
      message: `Ignored action: ${action}`,
      supported: supportedActions,
    });
  }

  // ── DEDUP CHECK: Reject replayed deliveries ─────────────────
  // GitHub sends X-GitHub-Delivery as a unique UUID per webhook.
  // If we've seen this ID before, skip processing entirely.
  // Return 200 (not 4xx) — GitHub retries on non-2xx codes.
  const duplicate = await isDuplicateDelivery(delivery);
  if (duplicate) {
    logger.warn(`🔁 Duplicate delivery=${delivery} — skipping (already processed)`);
    return res.status(200).json({
      message: 'Duplicate delivery — already processed',
      delivery,
    });
  }

  // ── Mark delivery as processed BEFORE async work ────────────
  // This prevents a second delivery arriving during our async
  // processing from being accepted too.
  const prNumber = req.body.pull_request.number;
  await markDeliveryProcessed(delivery, { event, action, prNumber });

  // ── Respond 202 IMMEDIATELY ─────────────────────────────────
  res.status(202).json({
    message: 'Webhook accepted — processing asynchronously',
    delivery,
    action,
    prNumber,
  });

  // ── Process asynchronously ──────────────────────────────────
  // setImmediate defers execution to the next event loop tick.
  // The HTTP response is already sent at this point.
  // Any errors here won't crash the request (it's already done).
  setImmediate(() => {
    processWebhookAsync(action, req.body, delivery).catch((error) => {
      logger.error(`Async webhook processing failed for delivery=${delivery}: ${error.message}`, {
        delivery,
        action,
        prNumber,
        stack: error.stack,
      });
      // Error is logged but cannot be sent to GitHub —
      // the response is already sent. This is by design.
      // Check logs or deployment store status for failures.
    });
  });
});

/**
 * Process webhook payload asynchronously (after 202 response).
 * Errors are caught by the caller and logged — not thrown to Express.
 */
async function processWebhookAsync(action, payload, delivery) {
  const prNumber = payload.pull_request.number;
  logger.info(`⚙️  Processing delivery=${delivery} action=${action} PR=#${prNumber}`);

  switch (action) {
    case 'opened':
    case 'reopened':
      await previewController.handlePROpened(payload);
      logger.info(`✅ Finished processing PR #${prNumber} opened (delivery=${delivery})`);
      break;

    case 'synchronize':
      await previewController.handlePRSynchronized(payload);
      logger.info(`✅ Finished processing PR #${prNumber} sync (delivery=${delivery})`);
      break;

    case 'closed':
      await previewController.handlePRClosed(payload);
      logger.info(`✅ Finished processing PR #${prNumber} closed (delivery=${delivery})`);
      break;
  }
}

module.exports = router;
