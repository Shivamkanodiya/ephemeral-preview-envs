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
//
// SUPPORTED EVENTS:
//   pull_request  → PR opened/closed/synchronize
//   issue_comment → /preview slash commands
// ============================================
const express = require('express');
const router = express.Router();
const { verifyGitHubWebhook } = require('../middleware/webhook.middleware');
const previewController = require('../controllers/preview.controller');
const { isDuplicateDelivery, markDeliveryProcessed } = require('../store/delivery.store');
const { logger } = require('../utils/logger');

// ============================================
// SLASH COMMANDS
// ============================================
// Users can comment on PRs with these commands:
//   /preview          → Trigger a preview deployment
//   /preview destroy  → Manually destroy the preview
//   /preview status   → Show current preview status
//
// The bot replies with a comment confirming the action.
// ============================================
const SLASH_COMMANDS = {
  DEPLOY:  /^\/preview\s*$/i,
  DESTROY: /^\/preview\s+destroy\s*$/i,
  STATUS:  /^\/preview\s+status\s*$/i,
};

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

  // ── Route by event type ─────────────────────────────────────
  if (event === 'pull_request') {
    return handlePullRequestEvent(req, res, action, delivery);
  }

  if (event === 'issue_comment') {
    return handleIssueCommentEvent(req, res, action, delivery);
  }

  // ── Ignore all other events ─────────────────────────────────
  return res.status(200).json({
    message: `Ignored event: ${event}`,
    hint: 'Only pull_request and issue_comment events are processed',
  });
});

// ============================================
// PULL REQUEST EVENT HANDLER
// ============================================
async function handlePullRequestEvent(req, res, action, delivery) {
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
  const duplicate = await isDuplicateDelivery(delivery);
  if (duplicate) {
    logger.warn(`🔁 Duplicate delivery=${delivery} — skipping (already processed)`);
    return res.status(200).json({
      message: 'Duplicate delivery — already processed',
      delivery,
    });
  }

  const prNumber = req.body.pull_request.number;
  await markDeliveryProcessed(delivery, { event: 'pull_request', action, prNumber });

  // ── Respond 202 IMMEDIATELY ─────────────────────────────────
  res.status(202).json({
    message: 'Webhook accepted — processing asynchronously',
    delivery,
    action,
    prNumber,
  });

  // ── Process asynchronously ──────────────────────────────────
  setImmediate(() => {
    processWebhookAsync(action, req.body, delivery).catch((error) => {
      logger.error(`Async webhook processing failed for delivery=${delivery}: ${error.message}`, {
        delivery,
        action,
        prNumber,
        stack: error.stack,
      });
    });
  });
}

// ============================================
// ISSUE COMMENT EVENT HANDLER (Slash Commands)
// ============================================
async function handleIssueCommentEvent(req, res, action, delivery) {
  // Only process newly created comments (not edits or deletes)
  if (action !== 'created') {
    return res.status(200).json({ message: 'Ignored comment action: ' + action });
  }

  const comment = req.body.comment;
  const issue = req.body.issue;

  // Only process comments on PRs (issues have no pull_request key)
  if (!issue?.pull_request) {
    return res.status(200).json({ message: 'Ignored: comment is not on a PR' });
  }

  // Extract comment body and check for slash command
  const body = (comment?.body || '').trim();
  let command = null;

  if (SLASH_COMMANDS.DESTROY.test(body)) {
    command = 'destroy';
  } else if (SLASH_COMMANDS.STATUS.test(body)) {
    command = 'status';
  } else if (SLASH_COMMANDS.DEPLOY.test(body)) {
    command = 'deploy';
  }

  if (!command) {
    return res.status(200).json({ message: 'No slash command found in comment' });
  }

  // ── DEDUP CHECK ─────────────────────────────────────────────
  const duplicate = await isDuplicateDelivery(delivery);
  if (duplicate) {
    return res.status(200).json({ message: 'Duplicate delivery', delivery });
  }

  const prNumber = issue.number;
  const owner = req.body.repository.owner.login;
  const repo = req.body.repository.name;

  await markDeliveryProcessed(delivery, { event: 'issue_comment', command, prNumber });

  logger.info(`🎮 Slash command: /${command} on PR #${prNumber} by ${comment.user?.login}`);

  // ── Respond 202 IMMEDIATELY ─────────────────────────────────
  res.status(202).json({
    message: `Command "/${command}" accepted for PR #${prNumber}`,
    delivery,
    command,
    prNumber,
  });

  // ── Process command asynchronously ──────────────────────────
  setImmediate(() => {
    processSlashCommand(command, req.body, delivery).catch((error) => {
      logger.error(`Slash command failed: /${command} on PR #${prNumber}: ${error.message}`, {
        delivery, command, prNumber, stack: error.stack,
      });
    });
  });
}

// ============================================
// ASYNC PROCESSORS
// ============================================

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

/**
 * Process slash commands from PR comments.
 * Builds a synthetic payload matching handlePROpened/handlePRClosed format.
 */
async function processSlashCommand(command, payload, delivery) {
  const prNumber = payload.issue.number;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const githubService = require('../services/github.service');

  switch (command) {
    case 'deploy': {
      // Fetch PR details to build a proper payload
      const prDetails = await fetchPRDetails(owner, repo, prNumber);
      if (!prDetails) {
        await githubService.upsertComment(owner, repo, prNumber,
          `⚠️ Could not fetch PR details for #${prNumber}. Is the PR still open?`
        );
        return;
      }
      // Build synthetic payload matching pull_request event format
      const syntheticPayload = {
        action: 'opened',
        pull_request: prDetails,
        repository: payload.repository,
      };
      await previewController.handlePROpened(syntheticPayload);
      logger.info(`✅ /preview deploy completed for PR #${prNumber}`);
      break;
    }

    case 'destroy': {
      const syntheticPayload = {
        action: 'closed',
        pull_request: {
          number: prNumber,
          merged: false,
          head: { ref: 'unknown' },
          user: { login: payload.comment.user?.login },
        },
        repository: payload.repository,
      };
      await previewController.handlePRClosed(syntheticPayload);
      logger.info(`✅ /preview destroy completed for PR #${prNumber}`);
      break;
    }

    case 'status': {
      const { deploymentStore } = require('../store/deployment.store');
      const record = await deploymentStore.get(prNumber);

      let statusMsg;
      if (!record) {
        statusMsg = `📋 **Preview Status — PR #${prNumber}**\n\nNo preview environment found. Comment \`/preview\` to create one.`;
      } else {
        statusMsg = [
          `📋 **Preview Status — PR #${prNumber}**\n`,
          `| Field | Value |`,
          `|-------|-------|`,
          `| Status | ${record.status} |`,
          `| URL | ${record.url || 'N/A'} |`,
          `| Branch | ${record.branch || 'N/A'} |`,
          `| Builds | ${record.buildCount || 0} |`,
          `| Created | ${record.createdAt ? new Date(record.createdAt).toUTCString() : 'N/A'} |`,
        ].join('\n');
      }

      await githubService.upsertComment(owner, repo, prNumber, statusMsg);
      logger.info(`✅ /preview status posted for PR #${prNumber}`);
      break;
    }
  }
}

/**
 * Fetch PR details from GitHub API (needed for /preview deploy command)
 */
async function fetchPRDetails(owner, repo, prNumber) {
  try {
    const githubService = require('../services/github.service');
    const response = await githubService.client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return response.data;
  } catch (error) {
    logger.error(`Failed to fetch PR #${prNumber} details: ${error.message}`);
    return null;
  }
}

module.exports = router;

