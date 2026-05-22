// ============================================
// Express App Configuration (Phase 8 — Production Security)
// ============================================
//
// SECURITY MIDDLEWARE STACK (order matters):
//   1. Helmet    → HTTP security headers (first — before anything)
//   2. CORS      → Cross-origin resource sharing
//   3. Rate limit→ Flood/DDoS protection
//   4. JSON parse→ Body parsing with raw body for webhooks
//   5. Request ID→ Distributed tracing
//   6. Logging   → Audit trail
//   7. Routes    → Business logic
//   8. 404       → Unknown routes
//   9. Error     → Centralized error handling
//
// WHY ORDER MATTERS:
// Middleware runs in registration order.
// Helmet must be first — it sets headers before any response.
// Error handler must be last — it catches errors from all above.
// ============================================
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const path     = require('path');
const { logger }   = require('./utils/logger');
const { AppError } = require('./utils/errors');
const config = require('./config');

const healthRoutes  = require('./routes/health.routes');
const webhookRoutes = require('./routes/webhook.routes');
const previewRoutes = require('./routes/preview.routes');

const app = express();

// Trust proxy — required behind Render's load balancer
// Without this: req.ip = load balancer IP, not client IP
// Result: all users share same IP → rate limiter blocks everyone
if (config.security.trustProxy) {
  app.set('trust proxy', 1); // Trust 1 hop (Render's LB)
}

// ============================================================
// 1. HELMET — HTTP Security Headers
// ============================================================
//
// Helmet sets ~15 security-related HTTP response headers.
// Each header tells the browser how to handle your page safely.
//
// HEADERS SET BY HELMET:
// ─────────────────────────────────────────────────────────────
// Content-Security-Policy    → Blocks XSS by whitelisting sources
// X-Frame-Options: SAMEORIGIN → Blocks clickjacking via iframes
// X-Content-Type-Options: nosniff → Prevents MIME sniffing attacks
// Strict-Transport-Security  → Forces HTTPS (no HTTP downgrade)
// X-DNS-Prefetch-Control: off→ Prevents DNS prefetch leaks
// Referrer-Policy            → Controls what URL is sent as referrer
// Permissions-Policy         → Disables browser features (camera, mic)
// Cross-Origin-*-Policy      → Controls cross-origin resource access
// ─────────────────────────────────────────────────────────────
app.use(
  helmet({
    // Content Security Policy — relaxed for dashboard, strict for API
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],   // Dashboard inline scripts
        styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc:      ["'self'", "data:"],
        connectSrc:  ["'self'"],
        fontSrc:     ["'self'", "https://fonts.gstatic.com"],
        objectSrc:   ["'none'"],
        mediaSrc:    ["'none'"],
        frameSrc:    ["'none'"],
      },
    },
    // HSTS: force HTTPS for 1 year, include subdomains
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    // Disable X-Powered-By: Express (don't reveal stack)
    // Helmet does this separately — hidePoweredBy below
  })
);
// Explicitly remove X-Powered-By header (reveals tech stack)
app.disable('x-powered-by');

// ============================================================
// 2. CORS — Cross-Origin Resource Sharing
// ============================================================
//
// WHY CORS EXISTS:
// Browsers enforce same-origin policy (SOP) — scripts on
// site A can't call APIs on site B without explicit permission.
// CORS is the mechanism that grants or denies that permission.
//
// For a webhook receiver, we need to be selective:
// - GitHub's servers (webhook source) → ALLOW
// - GitHub Actions (our CI/CD) → ALLOW
// - Unknown origins → DENY (prevents CSRF from malicious sites)
//
// Note: CORS is a BROWSER protection. Server-to-server calls
// (GitHub webhooks, Actions) don't have CORS restrictions.
// But it's still good practice to configure explicitly.
// ============================================================
const allowedOrigins = config.cors?.origins || [];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (server-to-server, curl, Postman)
      if (!origin) return callback(null, true);

      // In development: allow all
      if (config.nodeEnv === 'development') return callback(null, true);

      // In production: allowlist only
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Hub-Signature-256', // GitHub webhook signature
      'X-GitHub-Event',      // GitHub event type
      'X-GitHub-Delivery',   // GitHub delivery ID
      'X-Request-ID',        // Our tracing header
    ],
    credentials: false,      // No cookies — pure REST API
    maxAge: 86400,            // Cache preflight for 24h (reduces OPTIONS requests)
  })
);

// ============================================================
// 3. RATE LIMITING — Tiered Protection
// ============================================================
//
// WHY TIERED?
// Different endpoints have different risk profiles:
// - Health check: should NEVER be rate limited (monitoring tools)
// - Webhooks: GitHub sends up to ~10/min for busy repos
// - Preview API: developer dashboard calls — light traffic
// - Global: catch-all safety net
//
// express-rate-limit uses an in-memory sliding window.
// For multi-instance deployments, use redis-rate-limit instead.
// ============================================================

// Global rate limit — catch-all safety net
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                  // 200 requests per IP per 15min
  standardHeaders: true,     // Return RateLimit-* headers (RFC 6585)
  legacyHeaders: false,      // Disable X-RateLimit-* (deprecated)
  message: {
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMITED',
    retryAfter: '15 minutes',
  },
  skip: (req) => req.path === '/api/health', // Never limit health checks
});

// Webhook rate limit — allow bursts from GitHub
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute window
  max: 30,                   // 30 webhook events/minute
  message: {
    error: 'Webhook rate limit exceeded.',
    code: 'WEBHOOK_RATE_LIMITED',
  },
});

// API rate limit — stricter for management endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'API rate limit exceeded.',
    code: 'API_RATE_LIMITED',
  },
});

app.use(globalLimiter);

// ============================================================
// 4. BODY PARSING — with raw body preservation
// ============================================================
//
// WHY PRESERVE RAW BODY?
// GitHub webhook HMAC verification requires the EXACT raw bytes.
// Once express.json() parses the body, the raw buffer is gone.
// The `verify` callback fires before parsing — we save it there.
// Without rawBody: webhook signature verification always fails.
// ============================================================
app.use(
  express.json({
    limit: '1mb', // Max request body size (prevents memory exhaustion)
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString(); // Save raw body for HMAC verification
    },
  })
);

// ============================================================
// 5. REQUEST ID — Distributed Tracing
// ============================================================
//
// Assign a unique ID to every request.
// If GitHub sends X-Request-ID, we use that (preserves trace context).
// Otherwise generate one locally.
//
// Usage: Every log line includes requestId.
// When debugging a specific failed request, search logs for its ID.
// ============================================================
app.use((req, _res, next) => {
  req.requestId =
    req.headers['x-request-id'] ||
    req.headers['x-github-delivery'] || // Use GitHub delivery ID for webhooks
    generateRequestId();
  next();
});

// ============================================================
// 6. REQUEST LOGGING — Structured Audit Trail
// ============================================================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`, {
      requestId: req.requestId,
      ip:        req.ip,
      userAgent: req.get('User-Agent'),
    });
  });
  next();
});

// ============================================================
// 7. ROUTES
// ============================================================
app.use('/api/health',   healthRoutes);
app.use('/api/webhooks', webhookLimiter, webhookRoutes);
app.use('/api/previews', apiLimiter,     previewRoutes);

// ── Dashboard UI (served from /public) ─────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 8. 404 Handler
// ============================================================
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ============================================================
// 9. GLOBAL ERROR HANDLER
// ============================================================
//
// Express error handlers have 4 parameters: (err, req, res, next)
// Express identifies them by arity — must have exactly 4 params.
//
// TWO ERROR CATEGORIES:
// Operational:  Expected errors (bad input, rate limit, not found)
//               → Clean 4xx response, WARN log
// Programmer:   Unexpected bugs (null reference, type error)
//               → Generic 500 response, ERROR log with stack trace
// ============================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof AppError) {
    logger.warn(`[${err.code}] ${err.message}`, {
      statusCode: err.statusCode,
      requestId:  req.requestId,
    });
    return res.status(err.statusCode).json({
      error: err.message,
      code:  err.code,
    });
  }

  // Handle CORS errors specifically
  if (err.message?.startsWith('CORS:')) {
    return res.status(403).json({
      error: err.message,
      code: 'CORS_BLOCKED',
    });
  }

  // Programmer error — log full stack, generic response
  logger.error(`Unhandled error: ${err.message}`, {
    stack:     err.stack,
    requestId: req.requestId,
    path:      req.path,
  });

  res.status(500).json({
    error: 'Internal server error',
    code:  'INTERNAL_ERROR',
  });
});

// ============================================================
// HELPERS
// ============================================================
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

module.exports = app;
