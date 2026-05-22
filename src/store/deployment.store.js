// ============================================
// Deployment Store (Hybrid: MongoDB + In-Memory Fallback)
// ============================================
//
// WHY HYBRID:
// - If MongoDB is connected → use persistent storage
// - If MongoDB is NOT configured → use in-memory Map
// - This makes the app work with OR without a database
// - Perfect for development (no DB needed) and production (DB for persistence)
//
// HOW THE FALLBACK WORKS:
// Every method checks isDBConnected() first.
// If true → calls Mongoose model methods
// If false → calls the in-memory Map methods
//
// ============================================
const { logger } = require('../utils/logger');
const { isDBConnected } = require('../config/database');

// In-memory fallback store (from Phase 3)
const memoryStore = new Map();

// Lazy-load model to avoid errors when mongoose isn't connected
let DeploymentModel = null;
function getModel() {
  if (!DeploymentModel) {
    DeploymentModel = require('../models/deployment.model').Deployment;
  }
  return DeploymentModel;
}

/**
 * Deployment status constants
 */
const DeploymentStatus = {
  CREATING: 'creating',
  BUILDING: 'building',
  ACTIVE: 'active',
  SLEEPING: 'sleeping',
  DELETING: 'deleting',
  DESTROYED: 'destroyed',
  FAILED: 'failed',
};

// Allowed state transitions — prevents impossible states
// Key: current status → Value: array of valid next statuses
const ALLOWED_TRANSITIONS = {
  [DeploymentStatus.CREATING]:  [DeploymentStatus.ACTIVE, DeploymentStatus.BUILDING, DeploymentStatus.FAILED, DeploymentStatus.DELETING],
  [DeploymentStatus.BUILDING]:  [DeploymentStatus.ACTIVE, DeploymentStatus.FAILED, DeploymentStatus.DELETING, DeploymentStatus.BUILDING],
  [DeploymentStatus.ACTIVE]:    [DeploymentStatus.BUILDING, DeploymentStatus.SLEEPING, DeploymentStatus.DELETING, DeploymentStatus.FAILED],
  [DeploymentStatus.SLEEPING]:  [DeploymentStatus.ACTIVE, DeploymentStatus.DELETING, DeploymentStatus.FAILED],
  [DeploymentStatus.DELETING]:  [DeploymentStatus.DESTROYED, DeploymentStatus.FAILED],
  [DeploymentStatus.DESTROYED]: [], // Terminal state — no transitions out
  [DeploymentStatus.FAILED]:    [DeploymentStatus.CREATING, DeploymentStatus.DELETING], // Can retry or cleanup
};

function validateTransition(currentStatus, nextStatus) {
  // If no current record exists (first create), always allow
  if (!currentStatus) return true;
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    logger.warn(`⚠️ Invalid state transition: ${currentStatus} → ${nextStatus} (allowed: ${allowed.join(', ')})`);
    return false;
  }
  return true;
}

class DeploymentStore {
  // ============================================
  // CREATE
  // ============================================
  async create(data) {
    const record = {
      prNumber: data.prNumber,
      branch: data.branch,
      repoUrl: data.repoUrl,
      author: data.author || 'unknown',
      serviceName: `preview-pr-${data.prNumber}`,
      serviceId: null,
      url: null,
      status: DeploymentStatus.CREATING,
      buildCount: 0,
      lastError: null,
      prTitle: data.prTitle || null,
      repoOwner: data.owner || null,
      repoName: data.repo || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      destroyedAt: null,
    };

    if (isDBConnected()) {
      try {
        // Upsert: if PR already has a record, update it
        const Model = getModel();
        const doc = await Model.upsertByPR(data.prNumber, record);
        logger.info(`📦 [DB] Stored deployment for PR #${data.prNumber}`);
        return doc.toObject();
      } catch (error) {
        logger.error(`DB create failed, falling back: ${error.message}`);
      }
    }

    // In-memory fallback
    memoryStore.set(data.prNumber, record);
    logger.info(`📦 [Memory] Stored deployment for PR #${data.prNumber}`);
    return record;
  }

  // ============================================
  // READ
  // ============================================
  async get(prNumber) {
    if (isDBConnected()) {
      try {
        const Model = getModel();
        const doc = await Model.findByPR(prNumber);
        return doc ? doc.toObject() : null;
      } catch (error) {
        logger.error(`DB get failed: ${error.message}`);
      }
    }
    return memoryStore.get(prNumber) || null;
  }

  // ============================================
  // UPDATE
  // ============================================
  async update(prNumber, updates) {
    if (isDBConnected()) {
      try {
        const Model = getModel();
        const doc = await Model.findOneAndUpdate(
          { prNumber },
          { $set: { ...updates, updatedAt: new Date() } },
          { returnDocument: 'after' }
        );
        return doc ? doc.toObject() : null;
      } catch (error) {
        logger.error(`DB update failed: ${error.message}`);
      }
    }

    // In-memory fallback
    const record = memoryStore.get(prNumber);
    if (!record) return null;
    const updated = { ...record, ...updates, updatedAt: new Date().toISOString() };
    memoryStore.set(prNumber, updated);
    return updated;
  }

  // ============================================
  // LIFECYCLE TRANSITIONS (with state validation)
  // ============================================
  async markActive(prNumber, serviceId, url) {
    const current = await this.get(prNumber);
    if (!validateTransition(current?.status, DeploymentStatus.ACTIVE)) {
      logger.warn(`Skipping markActive for PR #${prNumber} — invalid from ${current?.status}`);
      return current;
    }

    if (isDBConnected()) {
      try {
        const Model = getModel();
        const doc = await Model.findByPR(prNumber);
        if (doc) {
          return (await doc.markActive(serviceId, url)).toObject();
        }
      } catch (error) {
        logger.error(`DB markActive failed: ${error.message}`);
      }
    }
    return this.update(prNumber, { serviceId, url, status: DeploymentStatus.ACTIVE });
  }

  async markFailed(prNumber, error) {
    const current = await this.get(prNumber);
    if (!validateTransition(current?.status, DeploymentStatus.FAILED)) {
      logger.warn(`Skipping markFailed for PR #${prNumber} — invalid from ${current?.status}`);
      return current;
    }

    if (isDBConnected()) {
      try {
        const Model = getModel();
        const doc = await Model.findByPR(prNumber);
        if (doc) {
          return (await doc.markFailed(error)).toObject();
        }
      } catch (error2) {
        logger.error(`DB markFailed failed: ${error2.message}`);
      }
    }
    return this.update(prNumber, { status: DeploymentStatus.FAILED, lastError: error });
  }

  async markDestroyed(prNumber) {
    const current = await this.get(prNumber);
    if (!validateTransition(current?.status, DeploymentStatus.DESTROYED)) {
      // For destroy, we still want to proceed even if transition is invalid
      // (e.g., if record is already destroyed, that's fine — idempotent)
      if (current?.status === DeploymentStatus.DESTROYED) {
        logger.debug(`PR #${prNumber} already destroyed — idempotent`);
        return current;
      }
      logger.warn(`Forcing markDestroyed for PR #${prNumber} from ${current?.status}`);
    }

    if (isDBConnected()) {
      try {
        const Model = getModel();
        const doc = await Model.findByPR(prNumber);
        if (doc) {
          return (await doc.markDestroyed()).toObject();
        }
      } catch (error) {
        logger.error(`DB markDestroyed failed: ${error.message}`);
      }
    }
    return this.update(prNumber, {
      status: DeploymentStatus.DESTROYED,
      destroyedAt: new Date().toISOString(),
    });
  }

  async incrementBuild(prNumber) {
    const current = await this.get(prNumber);
    if (!validateTransition(current?.status, DeploymentStatus.BUILDING)) {
      logger.warn(`Skipping incrementBuild for PR #${prNumber} — invalid from ${current?.status}`);
      return current;
    }

    if (isDBConnected()) {
      try {
        const Model = getModel();
        const doc = await Model.findByPR(prNumber);
        if (doc) {
          return (await doc.incrementBuild()).toObject();
        }
      } catch (error) {
        logger.error(`DB incrementBuild failed: ${error.message}`);
      }
    }

    const record = memoryStore.get(prNumber);
    if (!record) return null;
    return this.update(prNumber, {
      buildCount: (record.buildCount || 0) + 1,
      status: DeploymentStatus.BUILDING,
    });
  }

  // ============================================
  // QUERIES
  // ============================================
  async getActive() {
    if (isDBConnected()) {
      try {
        const Model = getModel();
        const docs = await Model.findActive();
        return docs.map((d) => d.toObject());
      } catch (error) {
        logger.error(`DB getActive failed: ${error.message}`);
      }
    }

    // In-memory fallback
    const active = [];
    for (const [, record] of memoryStore) {
      if (!['destroyed', 'failed'].includes(record.status)) {
        active.push(record);
      }
    }
    return active;
  }

  async getAll() {
    if (isDBConnected()) {
      try {
        const Model = getModel();
        const docs = await Model.find().sort({ createdAt: -1 });
        return docs.map((d) => d.toObject());
      } catch (error) {
        logger.error(`DB getAll failed: ${error.message}`);
      }
    }
    return Array.from(memoryStore.values());
  }

  async getStats() {
    if (isDBConnected()) {
      try {
        const Model = getModel();
        return await Model.getStats();
      } catch (error) {
        logger.error(`DB getStats failed: ${error.message}`);
      }
    }

    // In-memory stats
    const all = Array.from(memoryStore.values());
    const stats = { total: all.length };
    for (const d of all) {
      stats[d.status] = (stats[d.status] || 0) + 1;
    }
    return stats;
  }

  // ============================================
  // CLEANUP
  // ============================================

  /**
   * Delete destroyed records older than N days
   * Called by: cleanup cron or admin endpoint
   *
   * NOTE: If MongoDB TTL index is active, this is redundant
   * but kept as a manual trigger for immediate cleanup
   */
  async cleanupOlderThan(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    if (isDBConnected()) {
      try {
        const Model = getModel();
        const result = await Model.deleteMany({
          status: 'destroyed',
          destroyedAt: { $lt: cutoff },
        });
        logger.info(`🧹 Cleaned up ${result.deletedCount} old deployment records`);
        return result.deletedCount;
      } catch (error) {
        logger.error(`DB cleanup failed: ${error.message}`);
      }
    }

    // In-memory cleanup
    let count = 0;
    for (const [key, record] of memoryStore) {
      if (record.status === 'destroyed' && new Date(record.destroyedAt) < cutoff) {
        memoryStore.delete(key);
        count++;
      }
    }
    return count;
  }
}

// Singleton export
module.exports = {
  deploymentStore: new DeploymentStore(),
  DeploymentStatus,
};
