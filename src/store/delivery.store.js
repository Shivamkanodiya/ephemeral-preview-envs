// ============================================
// Webhook Delivery Deduplication Store
// ============================================
//
// PROBLEM:
// GitHub retries webhook deliveries if it doesn't receive
// a 2xx response within 10s. Even with our 202-immediately fix,
// network issues between GitHub → our server can cause retries
// with the SAME X-GitHub-Delivery ID.
//
// Without dedup: same PR opened event processed 2-3 times
// → 2-3 Render services created → quota exhausted.
//
// SOLUTION:
// Store every processed delivery ID. Before processing,
// check if we've seen it before. If yes → 200 OK, skip.
//
// STORAGE:
// - MongoDB: TTL index auto-expires after 24h
// - In-memory: Map with setTimeout-based cleanup
//
// 24h TTL is sufficient — GitHub stops retrying after ~8 hours.
// ============================================
const { logger } = require('../utils/logger');
const { isDBConnected } = require('../config/database');

// In-memory fallback — delivery IDs with auto-expiry
const memoryDeliveries = new Map();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Mongoose model — lazy loaded
let DeliveryModel = null;

function getDeliveryModel() {
  if (!DeliveryModel) {
    const mongoose = require('mongoose');

    // Only define schema once
    if (mongoose.models.WebhookDelivery) {
      DeliveryModel = mongoose.models.WebhookDelivery;
      return DeliveryModel;
    }

    const deliverySchema = new mongoose.Schema({
      deliveryId: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
      event: String,
      action: String,
      prNumber: Number,
      processedAt: {
        type: Date,
        default: Date.now,
        expires: 86400, // TTL: auto-delete after 24 hours
      },
    });

    DeliveryModel = mongoose.model('WebhookDelivery', deliverySchema);
  }
  return DeliveryModel;
}

/**
 * Check if a delivery ID has already been processed.
 * Returns true if duplicate (already seen), false if new.
 */
async function isDuplicateDelivery(deliveryId) {
  if (!deliveryId) return false; // No ID = can't dedup, allow through

  if (isDBConnected()) {
    try {
      const Model = getDeliveryModel();
      const existing = await Model.findOne({ deliveryId }).lean();
      return !!existing;
    } catch (error) {
      logger.error(`Delivery dedup check failed: ${error.message}`);
      // On DB error, allow through (fail-open for availability)
      return false;
    }
  }

  // In-memory fallback
  return memoryDeliveries.has(deliveryId);
}

/**
 * Mark a delivery ID as processed.
 * Call this AFTER accepting the webhook (before async processing).
 */
async function markDeliveryProcessed(deliveryId, metadata = {}) {
  if (!deliveryId) return;

  if (isDBConnected()) {
    try {
      const Model = getDeliveryModel();
      await Model.create({
        deliveryId,
        event: metadata.event,
        action: metadata.action,
        prNumber: metadata.prNumber,
      });
      logger.debug(`📋 Stored delivery ID: ${deliveryId}`);
      return;
    } catch (error) {
      // Duplicate key error (11000) means another worker already stored it
      if (error.code === 11000) {
        logger.debug(`Delivery ${deliveryId} already stored (race condition handled)`);
        return;
      }
      logger.error(`Failed to store delivery: ${error.message}`);
    }
  }

  // In-memory fallback with auto-expiry
  memoryDeliveries.set(deliveryId, {
    ...metadata,
    processedAt: Date.now(),
  });

  // Auto-cleanup after 24h to prevent memory leak
  setTimeout(() => {
    memoryDeliveries.delete(deliveryId);
  }, TTL_MS).unref(); // .unref() prevents timer from keeping process alive
}

module.exports = { isDuplicateDelivery, markDeliveryProcessed };
