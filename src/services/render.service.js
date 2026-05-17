// ============================================
// Render API Service (Phase 5 — Full Integration)
// ============================================
//
// HOW RENDER WORKS INTERNALLY:
// ─────────────────────────────
// 1. You call POST /v1/services with repo URL + branch
// 2. Render creates a "service" resource in their database
// 3. Render clones your repo from the specified branch
// 4. Render runs your buildCommand (npm install)
// 5. Render runs your startCommand (npm start)
// 6. Render assigns a URL: https://{service-name}.onrender.com
// 7. If autoDeploy=yes, any push to branch triggers rebuild
// 8. Free-tier services sleep after 15min of inactivity
// 9. On next request, cold start takes ~30 seconds
//
// RENDER API AUTHENTICATION:
// ─────────────────────────
// All requests need: Authorization: Bearer {RENDER_API_KEY}
// Get your key: https://dashboard.render.com → Account Settings → API Keys
// The key has FULL access to your account — treat it like a password.
//
// RATE LIMITS:
// ─────────────
// Render enforces rate limits (exact numbers not publicly documented).
// We handle 429 responses with exponential backoff.
// Best practice: add delays between bulk operations.
//
// ============================================

const axios = require('axios');
const config = require('../config');
const { logger } = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const {
  RenderAPIError,
  PreviewNotFoundError,
  QuotaExceededError,
} = require('../utils/errors');

// Free-tier limits
const MAX_PREVIEW_SERVICES = 3;
const POLL_INTERVAL_MS = 10000;  // 10 seconds between status checks
const MAX_POLL_ATTEMPTS = 30;    // 5 minutes max polling

class RenderService {
  constructor() {
    // ---- AXIOS CLIENT SETUP ----
    // Pre-configured with base URL and auth header.
    // Every request automatically includes the API key.
    this.client = axios.create({
      baseURL: config.render.baseUrl,   // https://api.render.com/v1
      headers: {
        Authorization: `Bearer ${config.render.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30s timeout
    });

    // ---- AXIOS RESPONSE INTERCEPTOR ----
    // Centralized logging for all API responses
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`Render API ${response.config.method?.toUpperCase()} ${response.config.url} → ${response.status}`);
        return response;
      },
      (error) => {
        const status = error.response?.status;
        const url = error.config?.url;
        logger.error(`Render API error: ${error.config?.method?.toUpperCase()} ${url} → ${status || 'NETWORK_ERROR'}`);

        // Rate limit detection
        if (status === 429) {
          const retryAfter = error.response.headers['retry-after'];
          logger.warn(`⚠️ Rate limited by Render. Retry-After: ${retryAfter || 'unknown'}s`);
        }

        return Promise.reject(error);
      }
    );
  }

  // ============================================
  // NAMING CONVENTION
  // ============================================
  // Format: preview-pr-{prNumber}
  //
  // WHY THIS FORMAT:
  // - "preview-" prefix → filterable (find all previews)
  // - "pr-" → identifies the source (pull request)
  // - "{number}" → unique per repo, predictable
  //
  // RESULTING URL: https://preview-pr-42.onrender.com
  //
  // Render generates URLs from service names:
  //   service name: "preview-pr-42"
  //   URL: "https://preview-pr-42.onrender.com"
  //
  // If name conflicts, Render appends random suffix:
  //   "preview-pr-42" → "preview-pr-42-abcd.onrender.com"
  // We handle this by checking the response URL.
  // ============================================

  generateServiceName(prNumber) {
    return `${config.preview.prefix}-pr-${prNumber}`;
  }

  generateExpectedUrl(prNumber) {
    return `https://${this.generateServiceName(prNumber)}.onrender.com`;
  }

  // ============================================
  // 1. CREATE PREVIEW SERVICE
  // ============================================
  //
  // RENDER API: POST /v1/services
  //
  // REQUEST BODY:
  // {
  //   type: "web_service",        ← Render service type
  //   name: "preview-pr-42",      ← Unique service name
  //   ownerId: "owner-xxx",       ← Your Render account ID
  //   repo: "https://github...",  ← Git repo to clone
  //   branch: "feature/login",    ← Which branch to deploy
  //   autoDeploy: "yes",          ← Auto-rebuild on push
  //   serviceDetails: {
  //     env: "node",              ← Runtime environment
  //     buildCommand: "npm install",
  //     startCommand: "npm start",
  //     plan: "free",             ← Free tier
  //     envVars: [...]            ← Env vars for the preview
  //   }
  // }
  //
  // RESPONSE (201 Created):
  // {
  //   "service": {
  //     "id": "srv-xxxxx",
  //     "name": "preview-pr-42",
  //     "serviceDetails": {
  //       "url": "https://preview-pr-42.onrender.com"
  //     }
  //   }
  // }
  //
  // WHAT HAPPENS AFTER:
  // Render queues the deployment → clones repo → builds → starts
  // This takes 2-5 minutes. The URL won't respond until build completes.
  // ============================================

  async createPreviewService(prNumber, branch, repoUrl) {
    const serviceName = this.generateServiceName(prNumber);
    logger.info(`📦 Creating preview: ${serviceName} | branch: ${branch}`);

    // ---- QUOTA GUARD ----
    // Check how many previews already exist before creating
    const existing = await this.listPreviewServices();
    if (existing.length >= MAX_PREVIEW_SERVICES) {
      throw new QuotaExceededError(
        `Free tier limit: ${existing.length}/${MAX_PREVIEW_SERVICES} previews active. ` +
        `Close a PR to free a slot.`
      );
    }

    // ---- BUILD REQUEST BODY ----
    const requestBody = {
      type: 'web_service',
      name: serviceName,
      ownerId: config.render.ownerId,
      repo: repoUrl,
      branch: branch,
      autoDeploy: 'yes',
      serviceDetails: {
        env: 'node',
        buildCommand: 'npm install',
        startCommand: 'npm start',
        plan: 'free',
        envVars: [
          { key: 'NODE_ENV', value: 'preview' },
          { key: 'PR_NUMBER', value: String(prNumber) },
          { key: 'BRANCH_NAME', value: branch },
        ],
      },
    };

    try {
      // ---- API CALL WITH RETRY ----
      const response = await withRetry(
        () => this.client.post('/services', requestBody),
        {
          maxRetries: 3,
          baseDelay: 2000,
          operationName: `Create ${serviceName}`,
        }
      );

      const service = response.data.service || response.data;
      const url = service.serviceDetails?.url || this.generateExpectedUrl(prNumber);

      logger.info(`✅ Preview created: ${url} (ID: ${service.id})`);

      return {
        success: true,
        serviceId: service.id,
        serviceName,
        url,
        branch,
        prNumber,
      };
    } catch (error) {
      // Handle duplicate name (409 Conflict)
      if (error.response?.status === 409) {
        logger.warn(`Service ${serviceName} already exists — treating as success`);
        return {
          success: true,
          serviceName,
          url: this.generateExpectedUrl(prNumber),
          prNumber,
          alreadyExisted: true,
        };
      }

      if (error.isOperational) throw error;
      throw new RenderAPIError(
        `Failed to create preview for PR #${prNumber}: ${error.message}`,
        error.response?.status,
        error.response?.data
      );
    }
  }

  // ============================================
  // 2. FIND SERVICE BY NAME
  // ============================================
  //
  // RENDER API: GET /v1/services?name={name}&limit=1
  //
  // Returns an array of service objects.
  // We filter by exact name match since the API does partial matching.
  //
  // RESPONSE FORMAT:
  // [
  //   {
  //     "service": {
  //       "id": "srv-xxxxx",
  //       "name": "preview-pr-42",
  //       "suspended": "not_suspended",
  //       "serviceDetails": { "url": "..." },
  //       "createdAt": "2024-01-15T..."
  //     }
  //   }
  // ]
  // ============================================

  async findServiceByName(serviceName) {
    try {
      const response = await withRetry(
        () => this.client.get('/services', {
          params: { name: serviceName, limit: 5 },
        }),
        { maxRetries: 2, operationName: `Find ${serviceName}` }
      );

      const services = response.data;
      // Exact match filter (API may return partial matches)
      const match = services.find((s) => {
        const name = s.service?.name || s.name;
        return name === serviceName;
      });

      if (match) {
        logger.debug(`Found service: ${serviceName}`);
      }
      return match || null;
    } catch (error) {
      logger.error(`Failed to find service ${serviceName}: ${error.message}`);
      return null;
    }
  }

  // ============================================
  // 3. GET SERVICE DETAILS (by ID)
  // ============================================
  //
  // RENDER API: GET /v1/services/{serviceId}
  //
  // Returns full service details including:
  // - Current deployment status
  // - URL
  // - Suspended state
  // - Created/updated timestamps
  // ============================================

  async getServiceDetails(serviceId) {
    try {
      const response = await withRetry(
        () => this.client.get(`/services/${serviceId}`),
        { maxRetries: 2, operationName: `Get details for ${serviceId}` }
      );
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      throw new RenderAPIError(
        `Failed to get service details: ${error.message}`,
        error.response?.status
      );
    }
  }

  // ============================================
  // 4. GET DEPLOYMENT STATUS (POLLING)
  // ============================================
  //
  // RENDER API: GET /v1/services/{serviceId}/deploys?limit=1
  //
  // DEPLOYMENT STATUSES:
  //   "created"      → Deployment queued
  //   "build_in_progress" → Building (npm install)
  //   "update_in_progress" → Starting the service
  //   "live"         → Running and serving traffic ✅
  //   "deactivated"  → Stopped/sleeping
  //   "build_failed" → Build error ❌
  //   "update_failed" → Start error ❌
  //   "canceled"     → Manually cancelled
  //
  // We use this to poll until the deployment is live or failed.
  // ============================================

  async getLatestDeployment(serviceId) {
    try {
      const response = await this.client.get(
        `/services/${serviceId}/deploys`,
        { params: { limit: 1 } }
      );
      const deploys = response.data;
      if (deploys.length === 0) return null;

      const deploy = deploys[0].deploy || deploys[0];
      return {
        id: deploy.id,
        status: deploy.status,
        createdAt: deploy.createdAt,
        updatedAt: deploy.updatedAt,
        finishedAt: deploy.finishedAt,
      };
    } catch (error) {
      logger.error(`Failed to get deployment status: ${error.message}`);
      return null;
    }
  }

  // ============================================
  // 5. POLL DEPLOYMENT UNTIL READY
  // ============================================
  //
  // After creating a service, Render takes 2-5 minutes to build.
  // This method polls the deployment status every 10 seconds
  // until it's "live" (success) or "*_failed" (error).
  //
  // FLOW:
  //   Poll → "created" → wait → "build_in_progress" → wait
  //   → "update_in_progress" → wait → "live" ✅
  //
  // TIMEOUT: 5 minutes (30 polls × 10s interval)
  // ============================================

  async pollDeploymentStatus(serviceId, prNumber) {
    logger.info(`⏳ Polling deployment status for PR #${prNumber}...`);

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const deploy = await this.getLatestDeployment(serviceId);

      if (!deploy) {
        logger.debug(`Poll ${attempt}: No deployment found yet`);
        await this._sleep(POLL_INTERVAL_MS);
        continue;
      }

      logger.debug(`Poll ${attempt}/${MAX_POLL_ATTEMPTS}: status=${deploy.status}`);

      switch (deploy.status) {
        case 'live':
          logger.info(`✅ PR #${prNumber} deployment is LIVE!`);
          return { ready: true, status: 'live', deploy };

        case 'build_failed':
        case 'update_failed':
        case 'canceled':
          logger.error(`❌ PR #${prNumber} deployment FAILED: ${deploy.status}`);
          return { ready: false, status: deploy.status, deploy };

        case 'deactivated':
          logger.info(`💤 PR #${prNumber} service is sleeping (free tier idle)`);
          return { ready: true, status: 'sleeping', deploy };

        default:
          // Still building — continue polling
          break;
      }

      await this._sleep(POLL_INTERVAL_MS);
    }

    logger.warn(`⏰ Polling timeout for PR #${prNumber} after ${MAX_POLL_ATTEMPTS} attempts`);
    return { ready: false, status: 'timeout' };
  }

  // ============================================
  // 6. DELETE PREVIEW SERVICE
  // ============================================
  //
  // RENDER API: DELETE /v1/services/{serviceId}
  //
  // Two-step process:
  //   Step 1: Find service by name → get service ID
  //   Step 2: Delete by service ID
  //
  // WHAT HAPPENS ON DELETE:
  // - Render stops the running process
  // - Destroys the container
  // - Removes the URL/DNS entry
  // - Frees the service slot
  // - Irreversible — can't undo
  //
  // RESPONSE: 204 No Content (success)
  // ============================================

  async deletePreviewService(prNumber) {
    const serviceName = this.generateServiceName(prNumber);
    logger.info(`🗑️ Deleting preview: ${serviceName}`);

    try {
      // Step 1: Find service
      const service = await this.findServiceByName(serviceName);
      if (!service) {
        logger.warn(`Service ${serviceName} not found — already deleted`);
        return { success: true, message: 'Already cleaned up', serviceName };
      }

      const serviceId = service.service?.id || service.id;

      // Step 2: Delete with retry
      await withRetry(
        () => this.client.delete(`/services/${serviceId}`),
        {
          maxRetries: 3,
          baseDelay: 1000,
          operationName: `Delete ${serviceName}`,
        }
      );

      logger.info(`✅ Preview deleted: ${serviceName} (ID: ${serviceId})`);
      return { success: true, serviceId, serviceName };
    } catch (error) {
      if (error.response?.status === 404) {
        logger.warn(`Service already gone (404)`);
        return { success: true, message: 'Already deleted', serviceName };
      }
      if (error.isOperational) throw error;
      throw new RenderAPIError(
        `Failed to delete PR #${prNumber}: ${error.message}`,
        error.response?.status,
        error.response?.data
      );
    }
  }

  // ============================================
  // 7. LIST ALL PREVIEW SERVICES
  // ============================================
  //
  // RENDER API: GET /v1/services?limit=50
  //
  // Returns ALL services on your account.
  // We filter client-side by our naming prefix.
  // ============================================

  async listPreviewServices() {
    try {
      const response = await withRetry(
        () => this.client.get('/services', { params: { limit: 50 } }),
        { maxRetries: 2, operationName: 'List services' }
      );

      const allServices = response.data;
      const prefix = config.preview.prefix;

      return allServices
        .filter((s) => {
          const name = s.service?.name || s.name;
          return name && name.startsWith(prefix);
        })
        .map((s) => {
          const svc = s.service || s;
          return {
            id: svc.id,
            name: svc.name,
            url: svc.serviceDetails?.url,
            suspended: svc.suspended,
            createdAt: svc.createdAt,
            updatedAt: svc.updatedAt,
          };
        });
    } catch (error) {
      // CRITICAL: Do NOT return [] — that would make quota check
      // see 0 services when Render is down, allowing unlimited creates.
      // Throwing here forces createPreviewService to fail safely.
      logger.error(`Failed to list previews: ${error.message}`);
      throw new RenderAPIError(
        `Cannot verify service quota: ${error.message}`,
        error.response?.status
      );
    }
  }

  // ============================================
  // 8. SUSPEND / RESUME SERVICE
  // ============================================
  //
  // RENDER API: POST /v1/services/{id}/suspend
  //             POST /v1/services/{id}/resume
  //
  // Useful for pausing previews without deleting them
  // (preserves the service config for quick restart)
  // ============================================

  async suspendService(serviceId) {
    try {
      await this.client.post(`/services/${serviceId}/suspend`);
      logger.info(`⏸️ Service ${serviceId} suspended`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to suspend: ${error.message}`);
      throw new RenderAPIError('Failed to suspend service', error.response?.status);
    }
  }

  async resumeService(serviceId) {
    try {
      await this.client.post(`/services/${serviceId}/resume`);
      logger.info(`▶️ Service ${serviceId} resumed`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to resume: ${error.message}`);
      throw new RenderAPIError('Failed to resume service', error.response?.status);
    }
  }

  // ---- Helper ----
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton export
module.exports = new RenderService();
