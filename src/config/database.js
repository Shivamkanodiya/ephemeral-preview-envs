// ============================================
// MongoDB Connection Manager (P1 Fix #7)
// ============================================
//
// FIX: Removed manual `isConnected` boolean flag.
// Problem was: if Mongoose auto-reconnects after a network blip,
// readyState becomes 1 but isConnected stays false (set only in
// the 'disconnected' handler, never toggled back by Mongoose).
// Result: app silently uses in-memory store even with live DB.
//
// Fix: Use ONLY mongoose.connection.readyState as the source of truth.
//   readyState 0 = disconnected
//   readyState 1 = connected
//   readyState 2 = connecting
//   readyState 3 = disconnecting
// ============================================
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');
const config = require('../config');

// Track whether we ever attempted a connection (not whether we're connected)
let connectionAttempted = false;

/**
 * Connect to MongoDB with retry logic
 */
async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    logger.debug('MongoDB already connected');
    return;
  }

  const uri = config.database.uri;

  if (!uri) {
    logger.warn('⚠️ MONGODB_URI not set — using in-memory store (data lost on restart)');
    return null;
  }

  connectionAttempted = true;

  try {
    const conn = await mongoose.connect(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 10000,
    });

    logger.info(`✅ MongoDB connected: ${conn.connection.host}`);

    // ---- CONNECTION EVENT HANDLERS ----
    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB error: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected — Mongoose will auto-reconnect');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('✅ MongoDB reconnected automatically');
    });

    return conn;
  } catch (error) {
    logger.error(`❌ MongoDB connection failed: ${error.message}`);
    logger.warn('Falling back to in-memory store');
    return null;
  }
}

/**
 * Disconnect gracefully (for tests and shutdown)
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected gracefully');
  }
}

/**
 * Check if MongoDB is connected.
 * Uses ONLY mongoose.connection.readyState — no manual flag.
 * This correctly handles Mongoose auto-reconnection.
 */
function isDBConnected() {
  // Only check readyState if we ever attempted to connect.
  // Without this guard, readyState could be 0 and we'd always
  // fall through to memory — which is correct, but this makes
  // the intent explicit.
  return connectionAttempted && mongoose.connection.readyState === 1;
}

module.exports = { connectDB, disconnectDB, isDBConnected };
