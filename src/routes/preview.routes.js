// ============================================
// Preview Management Routes (Audit Fix — Clean Separation)
// ============================================
// Routes ONLY call controller methods.
// No direct store or service imports here.
// Pattern: Route → Controller → Service/Store
// ============================================
const express = require('express');
const router  = express.Router();
const previewController = require('../controllers/preview.controller');
const {
  validatePRNumber,
  validateCleanupQuery,
} = require('../middleware/validation.middleware');

/**
 * GET /api/previews
 * List all active preview environments + statistics
 */
router.get('/', async (_req, res, next) => {
  try {
    const data = await previewController.listPreviews();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/previews/audit
 * Full deployment history (including destroyed, 30-day TTL window)
 */
router.get('/audit', async (_req, res, next) => {
  try {
    const log = await previewController.getAuditLog();
    res.status(200).json({ count: log.length, deployments: log });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/previews/cleanup
 * Manually trigger cleanup of old destroyed records
 * Query param: ?days=30 (default 30)
 */
router.post('/cleanup', validateCleanupQuery, async (req, res, next) => {
  try {
    const days = req.query.days || 30;
    const deletedCount = await previewController.manualCleanup(days);
    res.status(200).json({
      message: `Cleaned up deployments older than ${days} days`,
      deletedCount,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/previews/:prNumber/poll
 * Poll Render build status until live or failed
 */
router.get('/:prNumber/poll', validatePRNumber, async (req, res, next) => {
  try {
    const result = await previewController.pollDeployment(req.params.prNumber);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/previews/:prNumber
 * Status of a specific preview environment
 */
router.get('/:prNumber', validatePRNumber, async (req, res, next) => {
  try {
    const status = await previewController.getDeploymentStatus(req.params.prNumber);
    if (!status) {
      return res.status(404).json({
        error: `No preview found for PR #${req.params.prNumber}`,
        code:  'PREVIEW_NOT_FOUND',
      });
    }
    res.status(200).json(status);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/previews/:prNumber
 * Manual force-delete a preview environment
 */
router.delete('/:prNumber', validatePRNumber, async (req, res, next) => {
  try {
    const prNumber = req.params.prNumber;
    const result = await previewController.manualDelete(prNumber);
    res.status(200).json({
      message: `Preview for PR #${prNumber} deleted`,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
