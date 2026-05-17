# ============================================================
# Production Dockerfile — Multi-Stage Build
# ============================================================
#
# WHY MULTI-STAGE?
# A single-stage build includes ALL files: dev dependencies,
# test files, source maps, npm cache — bloating the image.
# Multi-stage uses separate build/production environments.
# Only the final stage ships to production.
#
# STAGES:
#   1. deps    → install ALL deps (including devDeps for build)
#   2. builder → prune to production-only deps
#   3. runner  → minimal image with only what's needed to RUN
#
# RESULT:
#   Without multi-stage: ~450MB image
#   With multi-stage:    ~120MB image  (73% smaller)
# ============================================================

# ── Stage 1: deps ─────────────────────────────────────────
# Purpose: Install all dependencies (including devDeps)
# Why node:18-alpine? Alpine Linux = 5MB base vs 900MB Debian
# Alpine has musl libc instead of glibc — smaller, secure
FROM node:18-alpine AS deps

# Install OS-level build tools needed by native npm packages
# (e.g., bcrypt, canvas) — not needed here but good practice
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy package manifests FIRST — before source code
# WHY: Docker caches layers. If package.json doesn't change,
# this layer is reused. Source code changes don't bust this cache.
# Without this trick: npm install runs on EVERY build.
COPY package.json package-lock.json ./

# npm ci = "clean install"
# Unlike npm install: uses exact package-lock.json versions
# Fails if lock file is out of sync — catches drift in CI
# Faster than npm install for CI/production (no resolution step)
RUN npm ci

# ── Stage 2: builder ──────────────────────────────────────
# Purpose: Prune to production-only dependencies
# We don't need jest, nodemon, eslint, supertest in prod image
FROM node:18-alpine AS builder

WORKDIR /app

# Copy everything from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prune devDependencies — removes ~60MB of test/dev tools
# This is what makes the final image lean
RUN npm prune --production

# ── Stage 3: runner ───────────────────────────────────────
# Purpose: The actual production image — minimal and secure
# Only this stage is pushed to the registry / deployed
FROM node:18-alpine AS runner

# ── Security: Run as non-root user ────────────────────────
# By default Docker runs as root inside containers.
# If attacker exploits app, they get ROOT access to host.
# Non-root user limits blast radius significantly.
#
# addgroup: create app group (GID 1001)
# adduser:  create app user (UID 1001), no password, no shell
# Install tini — proper PID 1 init process
# Node.js as PID 1 can't reap zombie processes.
# Tini forwards signals correctly and reaps orphans.
RUN apk add --no-cache tini

RUN addgroup --system --gid 1001 appgroup && \
    adduser  --system --uid 1001 --ingroup appgroup --no-create-home appuser

WORKDIR /app

# Set file ownership to appuser BEFORE switching user
# If we chown after USER, we don't have permission to chown
RUN chown appuser:appgroup /app

# ── Copy only what's needed from builder ──────────────────
# Explicit COPY = explicit about what ships to production
# node_modules: production deps only (devDeps pruned in builder)
# src/: application source code
# package.json: needed for module resolution + metadata
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/src         ./src
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# ── Switch to non-root user ───────────────────────────────
USER appuser

# ── Environment variables ─────────────────────────────────
# Only set build-time defaults here — never secrets!
# Runtime secrets are injected via Render env vars or Docker --env-file
ENV NODE_ENV=production \
    PORT=3000

# ── Health check ──────────────────────────────────────────
# Docker checks this every 30s. If it fails 3 times → container = unhealthy
# Orchestrators (Kubernetes, ECS) restart unhealthy containers automatically
# --interval=30s  : check every 30 seconds
# --timeout=5s    : give app 5s to respond before marking as failed
# --start-period=15s : wait 15s after start before first check
#                     (app needs time to connect to MongoDB)
# --retries=3     : 3 consecutive failures = unhealthy
#
# wget instead of curl: Alpine has wget built-in, curl is optional
# --spider: HEAD request only (don't download body)
# --no-verbose: suppress output (only exit code matters)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider \
      http://localhost:${PORT}/api/health || exit 1

# ── Expose port ───────────────────────────────────────────
# EXPOSE is documentation — it doesn't actually open ports.
# The actual port mapping is: docker run -p 3000:3000
# Render reads this to know which port to route traffic to.
EXPOSE ${PORT}

# ── Entrypoint: tini as PID 1 ─────────────────────────────
# Tini reaps zombie processes and forwards signals.
# Node gets SIGTERM correctly → graceful shutdown works.
ENTRYPOINT ["/sbin/tini", "--"]

# ── Start command ─────────────────────────────────────────
# Use node directly, not npm start (npm adds an extra process layer).
CMD ["node", "src/server.js"]
