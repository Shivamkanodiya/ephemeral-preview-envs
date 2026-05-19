// ============================================
// GitHub Service (Phase 7 — Full PR Comment Bot)
// ============================================
//
// WHAT THIS DOES:
// 1. Verifies incoming webhook HMAC signatures (security)
// 2. Creates richly formatted PR comments with markdown
// 3. Finds and UPDATES existing comments (no duplicates)
// 4. Sets GitHub Deployment Status API entries
// 5. Handles token auth + retry on rate limits
//
// WHY UPDATE vs CREATE new comments:
// Creating a new comment on every event = comment spam.
// Developers hate bots that flood their PRs.
// Instead we find our bot's EXISTING comment and edit it in-place.
// One comment per PR, always up-to-date.
//
// COMMENT LIFECYCLE:
//   PR opened   → CREATE comment (🚀 Deploying...)
//   Build ready → UPDATE comment (✅ Preview Ready)
//   PR sync     → UPDATE comment (🔄 Rebuilding...)
//   PR closed   → UPDATE comment (🧹 Cleaned Up)
// ============================================
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { logger } = require('../utils/logger');
const { withRetry } = require('../utils/retry');

// ============================================
// COMMENT IDENTITY MARKER
// ============================================
// We embed this hidden HTML comment at the top of every bot comment.
// GitHub renders it as invisible, but we can search for it
// when listing comments to find OUR comment among others.
//
// Without this: We'd have to track comment IDs in our DB,
// which adds complexity. This approach is self-contained.
// ============================================
const BOT_MARKER = '<!-- ephemeral-preview-bot -->';

class GitHubService {
  constructor() {
    // ── Axios instance: pre-configured for GitHub API ──────────────
    // Using an instance (not axios directly) means we set headers once.
    // All methods inherit auth, accept headers, and timeout.
    this.client = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${config.github.token}`,
        // GitHub requires this Accept header for v3 API
        Accept: 'application/vnd.github.v3+json',
        // Identifies our bot in GitHub's server logs (good practice)
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ephemeral-preview-bot/1.0',
      },
      timeout: 15000, // 15s — GitHub API is usually fast
    });

    // ── Rate limit interceptor ──────────────────────────────────────
    // GitHub limits: 5000 requests/hour for authenticated apps
    // On 403/429 with Retry-After header → wait and retry
    this.client.interceptors.response.use(
      (res) => res,
      async (error) => {
        const status = error.response?.status;
        const retryAfter = error.response?.headers?.['retry-after'];

        if ((status === 403 || status === 429) && retryAfter) {
          const waitMs = parseInt(retryAfter, 10) * 1000;
          logger.warn(`⏳ GitHub rate limited. Waiting ${retryAfter}s...`);
          await new Promise((r) => setTimeout(r, waitMs));
          return this.client.request(error.config); // retry once
        }
        return Promise.reject(error);
      }
    );
  }

  // ============================================================
  // REQUIREMENT 2: Secure Webhook Signature Verification
  // ============================================================
  //
  // HOW IT WORKS:
  // 1. GitHub hashes the raw request body with your webhook secret
  //    using HMAC-SHA256
  // 2. Sends the hash in the `X-Hub-Signature-256` header
  // 3. We compute the same hash ourselves
  // 4. Use timingSafeEqual() to compare — prevents timing attacks
  //
  // TIMING ATTACK EXPLAINED:
  // Regular string comparison (===) returns early when it finds
  // a mismatch. An attacker can measure response times to guess
  // the secret character by character.
  // timingSafeEqual() always takes the same time regardless.
  // ============================================================
  verifyWebhookSignature(payload, signature) {
    if (!config.github.webhookSecret) {
      if (config.nodeEnv === 'production') {
        // NEVER skip verification in production — fail hard
        logger.error('GITHUB_WEBHOOK_SECRET not set in production — rejecting all webhooks');
        return false;
      }
      logger.warn('Webhook secret not configured — skipping verification (dev only)');
      return true;
    }
    if (!signature) return false;

    const hmac = crypto.createHmac('sha256', config.github.webhookSecret);
    const digest = `sha256=${hmac.update(payload).digest('hex')}`;

    // Both buffers must be same length for timingSafeEqual
    if (digest.length !== signature.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(signature)
    );
  }

  // ============================================================
  // REQUIREMENT 7: Find Existing Bot Comment (Prevent Duplicates)
  // ============================================================
  //
  // GitHub API: GET /repos/:owner/:repo/issues/:prNumber/comments
  // Returns all comments on a PR (issues API handles PR comments too)
  //
  // We paginate through all comments (up to 100 per page)
  // and look for the BOT_MARKER in the body.
  //
  // Returns: comment object { id, body } or null if not found
  // ============================================================
  async findBotComment(owner, repo, prNumber) {
    try {
      // Fetch up to 100 comments (sufficient for most PRs)
      const response = await this.client.get(
        `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { params: { per_page: 100 } }
      );

      const botComment = response.data.find((comment) =>
        comment.body.includes(BOT_MARKER)
      );

      if (botComment) {
        logger.debug(`🔍 Found existing bot comment #${botComment.id} on PR #${prNumber}`);
      }

      return botComment || null;
    } catch (error) {
      // Non-fatal: if we can't find existing, we'll create new
      logger.warn(`Could not search for existing comment: ${error.message}`);
      return null;
    }
  }

  // ============================================================
  // REQUIREMENT 3 + 4: Create OR Update Comment (Smart Upsert)
  // ============================================================
  //
  // Pattern: "Find-then-update" — avoids comment spam
  //
  // CREATE: POST /repos/:owner/:repo/issues/:prNumber/comments
  // UPDATE: PATCH /repos/:owner/:repo/issues/comments/:commentId
  //
  // Note: GitHub uses "issues" API for PR comments too because
  // every PR is also an issue internally. PRs are issues with
  // an attached diff.
  // ============================================================
  async upsertComment(owner, repo, prNumber, body) {
    const existing = await this.findBotComment(owner, repo, prNumber);

    try {
      if (existing) {
        // UPDATE existing comment in-place
        await withRetry(
          () =>
            this.client.patch(
              `/repos/${owner}/${repo}/issues/comments/${existing.id}`,
              { body }
            ),
          { maxRetries: 3, operationName: 'github-update-comment' }
        );
        logger.info(`✏️  Updated bot comment #${existing.id} on PR #${prNumber}`);
        return { action: 'updated', commentId: existing.id };
      } else {
        // CREATE new comment
        const response = await withRetry(
          () =>
            this.client.post(
              `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
              { body }
            ),
          { maxRetries: 3, operationName: 'github-create-comment' }
        );
        const commentId = response.data.id;
        logger.info(`📝 Created bot comment #${commentId} on PR #${prNumber}`);
        return { action: 'created', commentId };
      }
    } catch (error) {
      logger.error(`Failed to upsert comment on PR #${prNumber}: ${error.message}`);
      // Non-fatal — deployment still works even if comment fails
    }
  }

  // ============================================================
  // REQUIREMENT 9: Markdown Comment Templates
  // ============================================================
  //
  // Each method builds a rich markdown body and calls upsertComment.
  //
  // MARKDOWN FEATURES USED:
  // - ## headings for visual hierarchy
  // - | tables | for structured data
  // - `code` for URLs and IDs
  // - > blockquote for notes
  // - emoji for instant visual scanning
  // - status badges (shields.io) for color indicators
  // - HTML comment (BOT_MARKER) for bot detection
  // ============================================================

  /**
   * Post "Deploying..." comment when PR is first opened.
   * Called immediately so developers know the bot saw the PR.
   * URL is not known yet — shows spinner state.
   */
  async postDeployingComment(owner, repo, prNumber, branch) {
    const body = this._buildDeployingBody(prNumber, branch);
    return this.upsertComment(owner, repo, prNumber, body);
  }

  /**
   * Update comment with live preview URL once Render is ready.
   * This is the most important comment — contains the clickable link.
   */
  async postPreviewComment(owner, repo, prNumber, previewUrl, metadata = {}) {
    const body = this._buildReadyBody(prNumber, previewUrl, metadata);
    return this.upsertComment(owner, repo, prNumber, body);
  }

  /**
   * Update comment to show rebuild in progress (PR synchronize event).
   * Keeps the old URL visible while the new build runs.
   */
  async postRebuildingComment(owner, repo, prNumber, previewUrl, buildCount) {
    const body = this._buildRebuildingBody(prNumber, previewUrl, buildCount);
    return this.upsertComment(owner, repo, prNumber, body);
  }

  /**
   * Update comment to show failure with error context.
   * Helps developers understand what went wrong.
   */
  async postFailedComment(owner, repo, prNumber, errorMessage) {
    const body = this._buildFailedBody(prNumber, errorMessage);
    return this.upsertComment(owner, repo, prNumber, body);
  }

  /**
   * Update comment to show cleanup complete on PR close/merge.
   * Final state — lets team know resources were freed.
   */
  async postCleanupComment(owner, repo, prNumber, merged = false) {
    const body = this._buildCleanupBody(prNumber, merged);
    return this.upsertComment(owner, repo, prNumber, body);
  }

  // ============================================================
  // REQUIREMENT 5: Deployment Status Badges + GitHub Deployments API
  // ============================================================
  //
  // GitHub has a separate "Deployments" API that shows deployment
  // status in the PR's merge checks area (the green/red status box).
  //
  // This is separate from PR comments — it's the official GitHub
  // deployment tracking system, visible in the Deployments tab.
  //
  // States: pending, in_progress, success, failure, inactive, error
  // ============================================================
  async createDeploymentStatus(owner, repo, prNumber, state, url = null) {
    if (!config.github.token) return; // Skip if no token configured

    try {
      // Step 1: Create a deployment record for this PR
      const deployRes = await withRetry(
        () =>
          this.client.post(`/repos/${owner}/${repo}/deployments`, {
            ref: `refs/pull/${prNumber}/head`,
            environment: 'preview',
            description: `Preview environment for PR #${prNumber}`,
            auto_merge: false,           // Don't auto-merge
            required_contexts: [],       // Don't wait for status checks
            transient_environment: true, // Mark as ephemeral
          }),
        { maxRetries: 2, operationName: 'github-create-deployment' }
      );

      const deploymentId = deployRes.data.id;

      // Step 2: Post the status for that deployment
      await withRetry(
        () =>
          this.client.post(
            `/repos/${owner}/${repo}/deployments/${deploymentId}/statuses`,
            {
              state,                                   // 'in_progress' | 'success' | 'failure'
              environment_url: url || undefined,       // Clickable URL in GitHub UI
              log_url: url || undefined,               // Link to logs
              description: this._getStatusDescription(state),
              environment: 'preview',
              auto_inactive: true,                     // Mark old deployments as inactive
            }
          ),
        { maxRetries: 2, operationName: 'github-deployment-status' }
      );

      logger.info(`🚦 Set GitHub deployment status: ${state} for PR #${prNumber}`);
    } catch (error) {
      // Non-fatal — status badge failure shouldn't block deployment
      logger.warn(`Could not set deployment status: ${error.message}`);
    }
  }

  // ============================================================
  // PRIVATE: Markdown Body Builders
  // ============================================================

  _buildDeployingBody(prNumber, branch) {
    const timestamp = new Date().toUTCString();
    return [
      BOT_MARKER,
      '',
      '## 🔄 Preview Environment — Deploying',
      '',
      `![status](https://img.shields.io/badge/status-deploying-yellow?style=flat-square)`,
      '',
      '> Your preview environment is being created. This usually takes **2–3 minutes**.',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **PR** | #${prNumber} |`,
      `| **Branch** | \`${branch}\` |`,
      `| **Status** | ⏳ Building... |`,
      `| **Started** | ${timestamp} |`,
      '',
      '*I\'ll update this comment with your preview URL as soon as it\'s ready.*',
      '',
      '---',
      '*🤖 Ephemeral Preview Bot — [powered by Render](https://render.com)*',
    ].join('\n');
  }

  _buildReadyBody(prNumber, previewUrl, metadata = {}) {
    const { branch = 'unknown', author = '', buildCount = 1, serviceId = '' } = metadata;
    const timestamp = new Date().toUTCString();

    return [
      BOT_MARKER,
      '',
      '## 🚀 Preview Environment Ready!',
      '',
      `![status](https://img.shields.io/badge/status-live-brightgreen?style=flat-square) ![env](https://img.shields.io/badge/environment-preview-blue?style=flat-square)`,
      '',
      `### 🔗 [Open Preview →](${previewUrl})`,
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **Preview URL** | [${previewUrl}](${previewUrl}) |`,
      `| **PR** | #${prNumber} |`,
      `| **Branch** | \`${branch}\` |`,
      `| **Author** | @${author} |`,
      `| **Status** | ✅ Live |`,
      `| **Build #** | ${buildCount} |`,
      `| **Service ID** | \`${serviceId || 'N/A'}\` |`,
      `| **Deployed at** | ${timestamp} |`,
      '',
      '> ⚠️ **Note:** This is a free-tier Render service. It may **sleep after 15 minutes** of inactivity. The first request after sleep takes ~30 seconds to wake up.',
      '',
      '> 🗑️ This preview will be **automatically destroyed** when the PR is merged or closed.',
      '',
      '---',
      '*🤖 Ephemeral Preview Bot — [powered by Render](https://render.com)*',
    ].join('\n');
  }

  _buildRebuildingBody(prNumber, oldUrl, buildCount) {
    const timestamp = new Date().toUTCString();
    return [
      BOT_MARKER,
      '',
      '## 🔄 Preview Environment — Rebuilding',
      '',
      `![status](https://img.shields.io/badge/status-rebuilding-yellow?style=flat-square) ![build](https://img.shields.io/badge/build-${buildCount}-orange?style=flat-square)`,
      '',
      '> New commits detected. Your preview is rebuilding...',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **PR** | #${prNumber} |`,
      `| **Status** | 🔄 Rebuilding (build #${buildCount}) |`,
      `| **Previous URL** | [${oldUrl}](${oldUrl}) *(may be stale)* |`,
      `| **Triggered at** | ${timestamp} |`,
      '',
      '*This comment will update automatically when the new build is ready.*',
      '',
      '---',
      '*🤖 Ephemeral Preview Bot — [powered by Render](https://render.com)*',
    ].join('\n');
  }

  _buildFailedBody(prNumber, errorMessage) {
    const timestamp = new Date().toUTCString();
    return [
      BOT_MARKER,
      '',
      '## ❌ Preview Environment — Failed',
      '',
      `![status](https://img.shields.io/badge/status-failed-red?style=flat-square)`,
      '',
      '> The preview environment failed to deploy. See error details below.',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **PR** | #${prNumber} |`,
      `| **Status** | ❌ Failed |`,
      `| **Failed at** | ${timestamp} |`,
      '',
      '**Error Details:**',
      '```',
      errorMessage || 'Unknown error occurred',
      '```',
      '',
      '**Possible causes:**',
      '- Build command failed (check your `package.json` scripts)',
      '- Environment variables missing on Render',
      '- Render free-tier service limit reached (max 3 services)',
      '- Network timeout during deployment',
      '',
      '> 🔁 Push a new commit to trigger a fresh deployment attempt.',
      '',
      '---',
      '*🤖 Ephemeral Preview Bot — [powered by Render](https://render.com)*',
    ].join('\n');
  }

  _buildCleanupBody(prNumber, merged) {
    const action = merged ? 'merged' : 'closed';
    const emoji = merged ? '🎉' : '🚪';
    const timestamp = new Date().toUTCString();

    return [
      BOT_MARKER,
      '',
      `## 🧹 Preview Environment — Cleaned Up`,
      '',
      `![status](https://img.shields.io/badge/status-destroyed-lightgrey?style=flat-square) ![action](https://img.shields.io/badge/PR-${action}-${merged ? 'purple' : 'red'}?style=flat-square)`,
      '',
      `> ${emoji} PR #${prNumber} was **${action}**. The preview environment has been destroyed.`,
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **PR** | #${prNumber} |`,
      `| **Action** | ${merged ? '✅ Merged' : '❌ Closed'} |`,
      `| **Preview Status** | 🗑️ Destroyed |`,
      `| **Cleaned up at** | ${timestamp} |`,
      '',
      '> All Render resources have been freed. No charges will accrue.',
      '',
      '---',
      '*🤖 Ephemeral Preview Bot — [powered by Render](https://render.com)*',
    ].join('\n');
  }

  _getStatusDescription(state) {
    const descriptions = {
      pending:     'Preview environment queued',
      in_progress: 'Preview environment deploying',
      success:     'Preview environment is live',
      failure:     'Preview environment deployment failed',
      inactive:    'Preview environment was destroyed',
      error:       'Preview environment encountered an error',
    };
    return descriptions[state] || state;
  }

  // ============================================
  // AUTO-LABEL MANAGEMENT
  // ============================================
  // Automatically adds/removes labels on PRs based on
  // preview environment status. Labels are created with
  // distinct colors on first use.
  //
  // Label lifecycle:
  //   PR opened      → add "preview-deploying" (yellow)
  //   Build ready    → remove "preview-deploying", add "preview-live" (green)
  //   Build failed   → remove "preview-deploying", add "preview-failed" (red)
  //   PR closed      → remove all preview labels, add "preview-destroyed" (gray)
  // ============================================

  // Label definitions with colors
  static LABELS = {
    DEPLOYING: { name: 'preview-deploying', color: 'fbca04', description: '⏳ Preview environment is being deployed' },
    LIVE:      { name: 'preview-live',      color: '0e8a16', description: '✅ Preview environment is live' },
    FAILED:    { name: 'preview-failed',    color: 'e11d48', description: '❌ Preview environment failed' },
    DESTROYED: { name: 'preview-destroyed', color: '6b7280', description: '🧹 Preview environment was cleaned up' },
  };

  /**
   * Ensure a label exists in the repo (create if missing)
   */
  async _ensureLabelExists(owner, repo, label) {
    try {
      await this.client.get(`/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`);
    } catch (error) {
      if (error.response?.status === 404) {
        try {
          await this.client.post(`/repos/${owner}/${repo}/labels`, {
            name: label.name,
            color: label.color,
            description: label.description,
          });
          logger.info(`🏷️ Created label: ${label.name}`);
        } catch (createError) {
          // 422 = label already exists (race condition)
          if (createError.response?.status !== 422) {
            logger.warn(`Failed to create label ${label.name}: ${createError.message}`);
          }
        }
      }
    }
  }

  /**
   * Add a label to a PR
   */
  async addLabel(owner, repo, prNumber, label) {
    try {
      await this._ensureLabelExists(owner, repo, label);
      await this.client.post(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
        labels: [label.name],
      });
      logger.debug(`🏷️ Added label "${label.name}" to PR #${prNumber}`);
    } catch (error) {
      // Non-critical — don't crash the flow
      logger.warn(`Failed to add label ${label.name} to PR #${prNumber}: ${error.message}`);
    }
  }

  /**
   * Remove a label from a PR
   */
  async removeLabel(owner, repo, prNumber, label) {
    try {
      await this.client.delete(
        `/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label.name)}`
      );
      logger.debug(`🏷️ Removed label "${label.name}" from PR #${prNumber}`);
    } catch (error) {
      // 404 = label not on this PR — that's fine
      if (error.response?.status !== 404) {
        logger.warn(`Failed to remove label ${label.name} from PR #${prNumber}: ${error.message}`);
      }
    }
  }

  /**
   * Remove all preview labels from a PR
   */
  async _removeAllPreviewLabels(owner, repo, prNumber) {
    const allLabels = Object.values(GitHubService.LABELS);
    await Promise.all(allLabels.map(label => this.removeLabel(owner, repo, prNumber, label)));
  }

  /**
   * Update PR labels based on preview status
   * Removes old labels and adds the new one
   */
  async updatePreviewLabels(owner, repo, prNumber, status) {
    await this._removeAllPreviewLabels(owner, repo, prNumber);

    const labelMap = {
      deploying: GitHubService.LABELS.DEPLOYING,
      live:      GitHubService.LABELS.LIVE,
      failed:    GitHubService.LABELS.FAILED,
      destroyed: GitHubService.LABELS.DESTROYED,
    };

    const label = labelMap[status];
    if (label) {
      await this.addLabel(owner, repo, prNumber, label);
    }
  }
}

module.exports = new GitHubService();
