// ============================================
// Server Entry Point (Phase 8 — Production Grade)
// ============================================
//
// STARTUP SEQUENCE:
//   1. Load env vars (dotenv)
//   2. Trust proxy (Render sits behind a load balancer)
//   3. Connect to MongoDB (or fall back to memory)
//   4. Start HTTP server
//   5. Register graceful shutdown handlers
//
// GRACEFUL SHUTDOWN:
//   When Render sends SIGTERM (deploy/scale/restart):
//   1. Stop accepting new connections
//   2. Wait for in-flight requests to finish (max 10s)
//   3. Close DB connection
//   4. Exit cleanly (exit code 0)
//
//   WHY THIS MATTERS:
//   Without graceful shutdown: in-flight webhook processing gets killed.
//   A PR event mid-processing → Render service created but never tracked.
//   Graceful shutdown prevents these orphans.
// ============================================
require('dotenv').config();

const app    = require('./app');
const { logger } = require('./utils/logger');
const config     = require('./config');
const { connectDB, disconnectDB } = require('./config/database');

const PORT = config.port;

// ── Trust Proxy ────────────────────────────────────────────────
// Render (and most PaaS) puts your app behind a reverse proxy.
// Without trust proxy: req.ip = proxy IP (not client IP)
// With trust proxy:    req.ip = real client IP (from X-Forwarded-For)
// Also fixes: express-rate-limit, secure cookies, HTTPS detection
app.set('trust proxy', config.security?.trustProxy ?? 1);

async function startServer() {
  // ── Connect to MongoDB ───────────────────────────────────────
  await connectDB();

  // ── Start HTTP server ────────────────────────────────────────
  const server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`📋 Environment: ${config.nodeEnv}`);
    logger.info(`💾 Database:    ${config.database.uri ? 'MongoDB Atlas' : 'In-Memory'}`);
    logger.info(`🛡️  Security:    Helmet + CORS + Rate Limiting active`);
    logger.info(`🔗 Health:      http://localhost:${PORT}/api/health`);
  });

  // ── Graceful Shutdown Handler ────────────────────────────────
  // Handles both SIGTERM (Docker stop / Render deploy) and
  // SIGINT (Ctrl+C in development)
  const shutdown = (signal) => async () => {
    logger.info(`\n${signal} received — starting graceful shutdown...`);

    // Step 1: Stop accepting new HTTP connections
    // Existing connections are allowed to finish
    server.close(async () => {
      logger.info('HTTP server closed — no new connections accepted');

      // Step 2: Close MongoDB connection
      await disconnectDB();
      logger.info('Database connection closed');

      // Step 3: Exit cleanly
      logger.info('Graceful shutdown complete. Goodbye! 👋');
      process.exit(0);
    });

    // Force shutdown after 10s if server.close() hangs
    // (e.g., a long-running keep-alive connection)
    setTimeout(() => {
      logger.error('Forced shutdown after timeout — some requests may have been lost');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', shutdown('SIGTERM')); // Render/Docker sends this
  process.on('SIGINT',  shutdown('SIGINT'));  // Ctrl+C in dev

  // ── Unhandled Promise Rejections ─────────────────────────────
  // Catch any unhandled promise rejection (missing await, etc.)
  // In Node.js 15+, unhandled rejections crash the process by default.
  // Log it before the crash so we have context.
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', { reason, promise });
    // Don't exit — let the process continue (non-fatal in most cases)
    // For truly fatal cases, the error will surface through normal error handling
  });

  // ── Uncaught Exceptions ──────────────────────────────────────
  // Programmer errors that escape all try/catch blocks
  // The process is in an unknown state — must exit
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception — process will exit', {
      message: error.message,
      stack:   error.stack,
    });
    process.exit(1); // Let process manager (Docker/Render) restart us
  });

  return server;
}

startServer().catch((error) => {
  logger.error(`Failed to start server: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
