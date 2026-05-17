// ============================================
// Health Check Routes (Enhanced)
// ============================================
// WHY THIS EXISTS:
// Every production service needs a health endpoint.
// Used by: load balancers, uptime monitors (UptimeRobot),
// Render health checks, Kubernetes liveness probes.
//
// Returns server status + deployment statistics so you
// can monitor the system at a glance.
// ============================================
const express = require('express');
const router = express.Router();
const { deploymentStore } = require('../store/deployment.store');

router.get('/', async (_req, res, next) => {
  try {
    const stats = await deploymentStore.getStats();

    res.status(200).json({
      status: 'healthy',
      service: 'ephemeral-preview-envs',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: `${Math.floor(process.uptime())}s`,
      memory: {
        used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
      },
      deployments: stats,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
