// ============================================
// Centralized Configuration
// All env vars validated and exported from here
// ============================================
const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  render: {
    apiKey: process.env.RENDER_API_KEY,
    ownerId: process.env.RENDER_OWNER_ID,
    baseUrl: 'https://api.render.com/v1',
  },

  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    token: process.env.GITHUB_TOKEN,
  },

  preview: {
    prefix: process.env.PREVIEW_PREFIX || 'preview',
    baseRepoUrl: process.env.BASE_REPO_URL,
  },

  database: {
    uri: process.env.MONGODB_URI || null,  // null = in-memory fallback
  },

  // CORS allowed origins (comma-separated in env var)
  // Empty = allow all in dev, deny unknown in prod
  cors: {
    origins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : [],
  },

  // Security settings
  security: {
    // Max request body size
    bodyLimit: process.env.BODY_LIMIT || '1mb',
    // Trust proxy: enable in production (behind Render's load balancer)
    // In development: false (running directly, no proxy)
    trustProxy: process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true',
  },
};

// Validate critical config on startup
const requiredKeys = ['render.apiKey', 'render.ownerId', 'github.webhookSecret'];

function validateConfig() {
  const missing = [];
  for (const key of requiredKeys) {
    const parts = key.split('.');
    let value = config;
    for (const part of parts) {
      value = value?.[part];
    }
    if (!value) missing.push(key);
  }
  if (missing.length > 0 && config.nodeEnv === 'production') {
    throw new Error(`Missing required config: ${missing.join(', ')}`);
  }
}

validateConfig();

module.exports = config;
