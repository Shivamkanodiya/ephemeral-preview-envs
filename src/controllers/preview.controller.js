// ============================================
// Preview Controller (Phase 7 — Full Comment Bot Integration)
// ============================================
// ORCHESTRATOR: Route → Controller → Services
// Every PR lifecycle event triggers both:
//   1. A deployment action (Render API)
//   2. A PR comment update (GitHub API)
//
// Comment states map to deployment states:
//   PR opened      → postDeployingComment  → createPreviewService → postPreviewComment
//   PR synchronize → postRebuildingComment → (Render auto-rebuilds)
//   PR closed      → postCleanupComment    → deletePreviewService
//   Failure        → postFailedComment
// ============================================
const renderService = require('../services/render.service');
const githubService = require('../services/github.service');
const { deploymentStore, DeploymentStatus } = require('../store/deployment.store');
const { logger } = require('../utils/logger');
const { ValidationError } = require('../utils/errors');

class PreviewController {
  /**
   * Handle PR opened/reopened events
   *
   * FLOW:
   * 1. Extract PR info from webhook payload
   * 2. Check for existing deployment (idempotency)
   * 3. Post "Deploying..." comment immediately (instant feedback)
   * 4. Create store record with CREATING status
   * 5. Call Render API to create service
   * 6. Update store with service ID + URL
   * 7. Set GitHub Deployment Status to 'success'
   * 8. Update PR comment with live preview URL
   */
  async handlePROpened(payload) {
    const pr = payload.pull_request;
    const prNumber = pr.number;
    const branch = pr.head.ref;
    const repoUrl = payload.repository.clone_url;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const author = pr.user?.login;
    const prTitle = pr.title;

    logger.info(`📬 PR #${prNumber} opened — branch: ${branch}`);

    // ── Idempotency: don't create duplicates ────────────────────
    const existing = await deploymentStore.get(prNumber);
    if (existing && existing.status === DeploymentStatus.ACTIVE) {
      logger.info(`Preview already active for PR #${prNumber}, skipping`);
      return { status: 'exists', ...existing };
    }

    // Also check Render (store may have been cleared on restart)
    const serviceName = renderService.generateServiceName(prNumber);
    const renderExisting = await renderService.findServiceByName(serviceName);
    if (renderExisting) {
      logger.info(`Preview exists on Render for PR #${prNumber}, syncing`);
      const svc = renderExisting.service || renderExisting;
      await deploymentStore.create({ prNumber, branch, repoUrl, owner, repo, author, prTitle });
      await deploymentStore.markActive(prNumber, svc.id, svc.serviceDetails?.url);
      return { status: 'exists', serviceName };
    }

    // ── Post "Deploying..." comment immediately ──────────────────
    // Developers see this right away — they know the bot is working
    // We post BEFORE the Render API call (which takes 2–3 minutes)
    const commentResult = await githubService.postDeployingComment(
      owner, repo, prNumber, branch
    );

    // ── Set GitHub Deployment Status to in_progress ──────────────
    await githubService.createDeploymentStatus(owner, repo, prNumber, 'in_progress');

    // ── Auto-label PR as deploying ───────────────────────────────
    await githubService.updatePreviewLabels(owner, repo, prNumber, 'deploying');

    // ── Store record with CREATING status ────────────────────────
    await deploymentStore.create({
      prNumber, branch, repoUrl, owner, repo, author, prTitle,
      commentId: commentResult?.commentId || null,
    });

    try {
      // ── Call Render API ─────────────────────────────────────────
      const result = await renderService.createPreviewService(prNumber, branch, repoUrl);

      // ── Update store with Render response ───────────────────────
      await deploymentStore.markActive(prNumber, result.serviceId, result.url);

      if (result.success) {
        // ── Update PR comment with live URL ─────────────────────
        await githubService.postPreviewComment(owner, repo, prNumber, result.url, {
          branch,
          author,
          buildCount: 1,
          serviceId: result.serviceId,
        });

        // ── Set GitHub Deployment Status to success ──────────────
        await githubService.createDeploymentStatus(
          owner, repo, prNumber, 'success', result.url
        );

        // ── Auto-label PR as live ─────────────────────────────────
        await githubService.updatePreviewLabels(owner, repo, prNumber, 'live');
      }

      return result;
    } catch (error) {
      // ── On failure: update comment + store + deployment status ──
      await deploymentStore.markFailed(prNumber, error.message);
      await githubService.postFailedComment(owner, repo, prNumber, error.message);
      await githubService.createDeploymentStatus(owner, repo, prNumber, 'failure');

      // ── Auto-label PR as failed ─────────────────────────────────
      await githubService.updatePreviewLabels(owner, repo, prNumber, 'failed');
      throw error;
    }
  }

  /**
   * Handle PR synchronize events (new commits pushed)
   *
   * Render's autoDeploy handles the actual rebuild automatically.
   * We update the comment to "Rebuilding..." so developers know
   * why their preview might temporarily be stale.
   */
  async handlePRSynchronized(payload) {
    const prNumber = payload.pull_request.number;
    const branch = payload.pull_request.head.ref;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    logger.info(`🔄 PR #${prNumber} synchronized — new commits on ${branch}`);

    const record = await deploymentStore.incrementBuild(prNumber);

    if (!record) {
      // No store record — could mean server restarted (in-memory mode).
      // Check Render API before blindly creating a duplicate service.
      const serviceName = renderService.generateServiceName(prNumber);
      const existing = await renderService.findServiceByName(serviceName);
      if (existing) {
        logger.info(`PR #${prNumber} service exists on Render but not in store — re-tracking`);
        const svc = existing.service || existing;
        await deploymentStore.create({
          prNumber, branch, repoUrl: payload.repository.clone_url,
          author: payload.pull_request.user.login,
          owner, repo,
        });
        await deploymentStore.markActive(prNumber, svc.id, svc.serviceDetails?.url);
        return { status: 'retracked', prNumber, serviceId: svc.id };
      }
      logger.info(`No store record or Render service for PR #${prNumber} — treating as new`);
      return this.handlePROpened(payload);
    }

    // ── Post "Rebuilding..." comment ─────────────────────────────
    // Shows old URL (still accessible during rebuild)
    // with a note that new build is in progress
    await githubService.postRebuildingComment(
      owner, repo, prNumber, record.url, record.buildCount
    );

    // ── Set Deployment Status back to in_progress ────────────────
    await githubService.createDeploymentStatus(owner, repo, prNumber, 'in_progress');

    return {
      status: 'rebuilding',
      prNumber,
      buildCount: record.buildCount,
      url: record.url,
    };
  }

  /**
   * Handle PR closed/merged events
   *
   * FLOW:
   * 1. Mark as DELETING in store
   * 2. Update PR comment to "Cleaning up..."
   * 3. Delete Render service
   * 4. Mark as DESTROYED in store
   * 5. Update PR comment to "Cleaned up!"
   * 6. Set GitHub Deployment Status to inactive
   */
  async handlePRClosed(payload) {
    const prNumber = payload.pull_request.number;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const merged = payload.pull_request.merged;

    logger.info(`📪 PR #${prNumber} ${merged ? 'merged' : 'closed'} — cleaning up`);

    await deploymentStore.update(prNumber, { status: DeploymentStatus.DELETING });

    try {
      const result = await renderService.deletePreviewService(prNumber);

      await deploymentStore.markDestroyed(prNumber);

      // ── Update comment with final cleanup state ──────────────
      await githubService.postCleanupComment(owner, repo, prNumber, merged);

      // ── Set Deployment Status to inactive ───────────────────
      await githubService.createDeploymentStatus(owner, repo, prNumber, 'inactive');

      // ── Auto-label PR as destroyed ──────────────────────────────
      await githubService.updatePreviewLabels(owner, repo, prNumber, 'destroyed');

      return { ...result, merged };
    } catch (error) {
      await deploymentStore.markFailed(prNumber, `Cleanup failed: ${error.message}`);
      await githubService.postFailedComment(owner, repo, prNumber, error.message);
      throw error;
    }
  }

  /**
   * Poll deployment status until ready or failed
   * Used by: GET /api/previews/:prNumber/poll
   */
  async pollDeployment(prNumber) {
    const record = await deploymentStore.get(prNumber);
    if (!record || !record.serviceId) {
      throw new ValidationError(`No active deployment found for PR #${prNumber}`);
    }

    const result = await renderService.pollDeploymentStatus(record.serviceId, prNumber);

    if (result.ready) {
      await deploymentStore.update(prNumber, { status: 'active' });
    } else if (result.status === 'build_failed' || result.status === 'update_failed') {
      await deploymentStore.markFailed(prNumber, `Deployment ${result.status}`);
    }

    return { prNumber, ...result, url: record.url };
  }

  /**
   * Get deployment status for a specific PR
   */
  async getDeploymentStatus(prNumber) {
    if (!prNumber || isNaN(prNumber)) {
      throw new ValidationError('Invalid PR number');
    }

    const record = await deploymentStore.get(prNumber);
    if (record) return { source: 'store', ...record };

    const serviceName = renderService.generateServiceName(prNumber);
    const service = await renderService.findServiceByName(serviceName);

    if (service) {
      const svc = service.service || service;
      return {
        source: 'render',
        prNumber,
        serviceName: svc.name,
        serviceId: svc.id,
        url: svc.serviceDetails?.url,
        status: svc.suspended === 'suspended' ? 'sleeping' : 'active',
        createdAt: svc.createdAt,
      };
    }

    return null;
  }

  /**
   * Poll Render deployment status until ready or failed
   * Used by: GET /api/previews/:prNumber/poll
   */
  async pollDeployment(prNumber) {
    if (!prNumber || isNaN(prNumber)) {
      throw new ValidationError('Invalid PR number');
    }

    const record = await deploymentStore.get(prNumber);
    if (!record || !record.serviceId) {
      return { ready: false, status: 'not_found', prNumber };
    }

    const result = await renderService.pollDeploymentStatus(record.serviceId, prNumber);

    // Update store based on poll result
    if (result.ready && result.status === 'live') {
      await deploymentStore.markActive(prNumber, record.serviceId, record.url);
    } else if (!result.ready && ['build_failed', 'update_failed'].includes(result.status)) {
      await deploymentStore.markFailed(prNumber, `Deployment ${result.status}`);
    }

    return result;
  }

  /**
   * List all tracked deployments with stats
   */
  async listPreviews() {
    const active = await deploymentStore.getActive();
    const stats = await deploymentStore.getStats();
    return { stats, deployments: active };
  }

  /**
   * Get full audit log (all deployments including destroyed)
   */
  async getAuditLog() {
    return await deploymentStore.getAll();
  }

  /**
   * Manual force-delete a preview environment
   * Used by: DELETE /api/previews/:prNumber
   */
  async manualDelete(prNumber) {
    logger.info(`🔧 Manual deletion requested for PR #${prNumber}`);
    const result = await renderService.deletePreviewService(prNumber);
    await deploymentStore.markDestroyed(prNumber);
    return result;
  }

  /**
   * Manual cleanup of old destroyed records
   * Used by: POST /api/previews/cleanup
   */
  async manualCleanup(days = 30) {
    const deleted = await deploymentStore.cleanupOlderThan(days);
    logger.info(`🧹 Manual cleanup: removed ${deleted} records older than ${days} days`);
    return deleted;
  }
}

module.exports = new PreviewController();
