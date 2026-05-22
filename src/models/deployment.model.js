// ============================================
// Deployment Model (Mongoose Schema)
// ============================================
//
// WHY MONGOOSE:
// Mongoose provides schema validation, middleware hooks,
// query helpers, and indexing — all critical for production.
//
// SCHEMA DESIGN DECISIONS:
// ─────────────────────────
// 1. prNumber is the PRIMARY lookup key (unique index)
//    → Every query starts with "find by PR number"
//
// 2. status is an ENUM with fixed values
//    → Prevents invalid states, enables filtered queries
//
// 3. timestamps: true adds createdAt/updatedAt automatically
//    → No manual date management
//
// 4. TTL index on destroyedAt (30 days)
//    → MongoDB auto-deletes old records for free-tier space
//
// 5. Compound index on [status, createdAt]
//    → Fast queries for "all active sorted by newest"
//
// ============================================
const mongoose = require('mongoose');

/**
 * Valid deployment statuses
 * Maps to the lifecycle stages of a preview environment
 */
const DEPLOYMENT_STATUSES = [
  'creating',     // API call sent to Render
  'building',     // Render is building (npm install)
  'active',       // Live and serving traffic
  'sleeping',     // Free-tier idle sleep
  'deleting',     // Deletion in progress
  'destroyed',    // Successfully cleaned up
  'failed',       // Creation or build failed
];

const deploymentSchema = new mongoose.Schema(
  {
    // ---- CORE IDENTIFIERS ----

    // PR number — the primary business key
    // Unique because one preview per PR at any time
    prNumber: {
      type: Number,
      required: [true, 'PR number is required'],
      unique: true,
      index: true,
    },

    // Git branch name (e.g., "feature/login-page")
    branch: {
      type: String,
      required: [true, 'Branch name is required'],
      trim: true,
    },

    // ---- RENDER SERVICE INFO ----

    // Render service ID (e.g., "srv-xxxxx")
    // Set after Render API responds with the created service
    serviceId: {
      type: String,
      default: null,
      sparse: true,  // Allow null but index non-null values
    },

    // Generated service name (e.g., "preview-pr-42")
    serviceName: {
      type: String,
      required: true,
    },

    // Preview URL (e.g., "https://preview-pr-42.onrender.com")
    url: {
      type: String,
      default: null,
    },

    // ---- LIFECYCLE STATE ----

    // Current deployment status
    status: {
      type: String,
      enum: {
        values: DEPLOYMENT_STATUSES,
        message: 'Invalid status: {VALUE}',
      },
      default: 'creating',
      index: true,
    },

    // Number of times this preview was rebuilt (PR updates)
    buildCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ---- GITHUB METADATA ----

    // PR author's GitHub username
    author: {
      type: String,
      default: 'unknown',
    },

    // PR title for display purposes
    prTitle: {
      type: String,
      default: null,
    },

    // Repository info
    repoOwner: {
      type: String,
      default: null,
    },

    repoName: {
      type: String,
      default: null,
    },

    repoUrl: {
      type: String,
      default: null,
    },

    // ---- GITHUB COMMENT TRACKING ----

    // GitHub PR comment ID for in-place updates
    // Stored so we can PATCH the same comment rather than creating new ones
    commentId: {
      type: Number,
      default: null,
    },

    // ---- ERROR TRACKING ----

    // Last error message (if status === 'failed')
    lastError: {
      type: String,
      default: null,
    },

    // ---- CLEANUP TIMESTAMPS ----

    // When the preview was destroyed (for TTL)
    destroyedAt: {
      type: Date,
      default: null,
    },
  },
  {
    // ---- SCHEMA OPTIONS ----

    // Automatically add createdAt and updatedAt fields
    timestamps: true,

    // Include virtuals when converting to JSON
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ============================================
// INDEXES
// ============================================
//
// WHY INDEXES MATTER:
// Without indexes, MongoDB scans EVERY document for queries.
// With 1000 deployments, that's 1000 reads per query.
// Indexes make lookups O(log n) instead of O(n).
//
// INDEX TYPES USED:
// 1. Unique index (prNumber) → enforces one-preview-per-PR
// 2. Regular index (status) → fast filtered queries
// 3. Compound index (status + createdAt) → sorted active list
// 4. TTL index (destroyedAt) → auto-delete after 30 days
// ============================================

// Compound index: efficiently query "all active deployments sorted by newest"
deploymentSchema.index({ status: 1, createdAt: -1 });

// TTL index: auto-delete destroyed records after 30 days
// MongoDB checks every 60 seconds and deletes expired docs
// This keeps the free-tier storage usage low
deploymentSchema.index(
  { destroyedAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days
    partialFilterExpression: { destroyedAt: { $ne: null } },
  }
);

// ============================================
// VIRTUALS
// ============================================

// Computed property: how long the deployment has been running
deploymentSchema.virtual('age').get(function () {
  const ms = Date.now() - this.createdAt.getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
});

// Is this deployment currently active?
deploymentSchema.virtual('isActive').get(function () {
  return ['creating', 'building', 'active', 'sleeping'].includes(this.status);
});

// ============================================
// STATIC METHODS (called on Model)
// ============================================

/**
 * Find active deployments (not destroyed/failed)
 * Usage: Deployment.findActive()
 */
deploymentSchema.statics.findActive = function () {
  return this.find({
    status: { $in: ['creating', 'building', 'active', 'sleeping'] },
  }).sort({ createdAt: -1 });
};

/**
 * Find by PR number (most common query)
 * Usage: Deployment.findByPR(42)
 */
deploymentSchema.statics.findByPR = function (prNumber) {
  return this.findOne({ prNumber });
};

/**
 * Get deployment statistics
 * Usage: Deployment.getStats()
 */
deploymentSchema.statics.getStats = async function () {
  const results = await this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]);

  const stats = { total: 0 };
  for (const r of results) {
    stats[r._id] = r.count;
    stats.total += r.count;
  }
  return stats;
};

/**
 * Upsert deployment (create or update)
 * Handles duplicate PRs gracefully
 * Usage: Deployment.upsertByPR(42, { branch: 'feat/x', ... })
 */
deploymentSchema.statics.upsertByPR = function (prNumber, data) {
  return this.findOneAndUpdate(
    { prNumber },
    { $set: data },
    {
      returnDocument: 'after', // Return updated document
      upsert: true,         // Create if doesn't exist
      runValidators: true,  // Validate on update too
    }
  );
};

// ============================================
// INSTANCE METHODS (called on document)
// ============================================

/**
 * Transition to active state with Render details
 */
deploymentSchema.methods.markActive = function (serviceId, url) {
  this.serviceId = serviceId;
  this.url = url;
  this.status = 'active';
  return this.save();
};

/**
 * Transition to failed state with error
 */
deploymentSchema.methods.markFailed = function (error) {
  this.status = 'failed';
  this.lastError = error;
  return this.save();
};

/**
 * Transition to destroyed state
 */
deploymentSchema.methods.markDestroyed = function () {
  this.status = 'destroyed';
  this.destroyedAt = new Date();
  return this.save();
};

/**
 * Increment build count (PR updated)
 */
deploymentSchema.methods.incrementBuild = function () {
  this.buildCount += 1;
  this.status = 'building';
  return this.save();
};

// ============================================
// MIDDLEWARE (hooks)
// ============================================

// Log every save for debugging
deploymentSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    // Status transition logged at the service layer
  }
  next();
});

const Deployment = mongoose.model('Deployment', deploymentSchema);

module.exports = { Deployment, DEPLOYMENT_STATUSES };
