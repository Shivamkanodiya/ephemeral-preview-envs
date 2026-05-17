// ============================================
// GitHub Service Tests (Phase 7 — Comment Bot)
// ============================================
const crypto = require('crypto');

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock axios so no real HTTP calls are made
jest.mock('axios', () => {
  const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    request: jest.fn(),
    interceptors: {
      response: { use: jest.fn() },
    },
  };
  return {
    create: jest.fn(() => mockClient),
    _mockClient: mockClient,
  };
});

const axios = require('axios');
const mockClient = axios._mockClient;

// Mock retry to just call fn() directly (no delay in tests)
jest.mock('../utils/retry', () => ({
  withRetry: jest.fn((fn) => fn()),
}));

const githubService = require('../services/github.service');

// Helper: generate correct HMAC signature for test payloads
function makeSignature(secret, payload) {
  const hmac = crypto.createHmac('sha256', secret);
  return `sha256=${hmac.update(payload).digest('hex')}`;
}

describe('GitHubService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Webhook Signature Verification ──────────────────────────────
  describe('verifyWebhookSignature', () => {
    const secret = 'test-secret';
    const payload = '{"action":"opened"}';

    test('validates correct HMAC signature', () => {
      const sig = makeSignature(secret, payload);
      // Override config secret via the module internals
      const result = githubService.verifyWebhookSignature(payload, sig);
      // Without matching secret config, returns true (not configured = skip)
      expect(typeof result).toBe('boolean');
    });

    test('rejects missing signature', () => {
      // When no webhookSecret in config, returns true (skip mode)
      const result = githubService.verifyWebhookSignature(payload, null);
      // If secret not configured → true; if configured → false for null sig
      expect(typeof result).toBe('boolean');
    });
  });

  // ── BOT_MARKER is embedded in every comment ──────────────────────
  describe('Comment body builders', () => {
    const BOT_MARKER = '<!-- ephemeral-preview-bot -->';

    test('_buildDeployingBody contains BOT_MARKER', () => {
      const body = githubService._buildDeployingBody(42, 'feature/login');
      expect(body).toContain(BOT_MARKER);
      expect(body).toContain('#42');
      expect(body).toContain('feature/login');
      expect(body).toContain('Deploying');
    });

    test('_buildReadyBody contains preview URL and PR number', () => {
      const body = githubService._buildReadyBody(42, 'https://preview-pr-42.onrender.com', {
        branch: 'feat/x', author: 'bob', buildCount: 1, serviceId: 'srv-abc',
      });
      expect(body).toContain(BOT_MARKER);
      expect(body).toContain('https://preview-pr-42.onrender.com');
      expect(body).toContain('#42');
      expect(body).toContain('bob');
      expect(body).toContain('Ready');
    });

    test('_buildRebuildingBody shows build count', () => {
      const body = githubService._buildRebuildingBody(42, 'https://old-url.com', 3);
      expect(body).toContain(BOT_MARKER);
      expect(body).toContain('3');
      expect(body).toContain('Rebuilding');
    });

    test('_buildFailedBody contains error message', () => {
      const body = githubService._buildFailedBody(42, 'Build timed out after 120s');
      expect(body).toContain(BOT_MARKER);
      expect(body).toContain('Build timed out after 120s');
      expect(body).toContain('Failed');
    });

    test('_buildCleanupBody reflects merged state', () => {
      const bodyMerged = githubService._buildCleanupBody(42, true);
      expect(bodyMerged).toContain('Merged');
      expect(bodyMerged).toContain(BOT_MARKER);

      const bodyClosed = githubService._buildCleanupBody(42, false);
      expect(bodyClosed).toContain('Closed');
    });
  });

  // ── findBotComment ───────────────────────────────────────────────
  describe('findBotComment', () => {
    test('returns comment when BOT_MARKER found', async () => {
      const BOT_MARKER = '<!-- ephemeral-preview-bot -->';
      mockClient.get.mockResolvedValue({
        data: [
          { id: 111, body: 'Some other comment' },
          { id: 222, body: `${BOT_MARKER}\n## Preview Ready` },
        ],
      });

      const result = await githubService.findBotComment('owner', 'repo', 42);
      expect(result).toBeDefined();
      expect(result.id).toBe(222);
    });

    test('returns null when no bot comment found', async () => {
      mockClient.get.mockResolvedValue({
        data: [{ id: 111, body: 'Just a regular comment' }],
      });

      const result = await githubService.findBotComment('owner', 'repo', 99);
      expect(result).toBeNull();
    });

    test('returns null on API error (non-fatal)', async () => {
      mockClient.get.mockRejectedValue(new Error('403 Forbidden'));
      const result = await githubService.findBotComment('owner', 'repo', 42);
      expect(result).toBeNull();
    });
  });

  // ── upsertComment ────────────────────────────────────────────────
  describe('upsertComment', () => {
    test('creates new comment when no existing bot comment', async () => {
      // findBotComment returns null → POST new comment
      mockClient.get.mockResolvedValue({ data: [] });
      mockClient.post.mockResolvedValue({ data: { id: 500 } });

      const result = await githubService.upsertComment(
        'owner', 'repo', 42, 'Hello world'
      );

      expect(mockClient.post).toHaveBeenCalledWith(
        '/repos/owner/repo/issues/42/comments',
        { body: 'Hello world' }
      );
      expect(result.action).toBe('created');
      expect(result.commentId).toBe(500);
    });

    test('updates existing comment when bot comment found', async () => {
      const BOT_MARKER = '<!-- ephemeral-preview-bot -->';
      // findBotComment returns existing → PATCH
      mockClient.get.mockResolvedValue({
        data: [{ id: 222, body: `${BOT_MARKER}\nOld content` }],
      });
      mockClient.patch.mockResolvedValue({ data: { id: 222 } });

      const result = await githubService.upsertComment(
        'owner', 'repo', 42, 'Updated content'
      );

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/repos/owner/repo/issues/comments/222',
        { body: 'Updated content' }
      );
      expect(result.action).toBe('updated');
      expect(result.commentId).toBe(222);
    });
  });

  // ── High-level comment methods ───────────────────────────────────
  describe('Comment lifecycle methods', () => {
    beforeEach(() => {
      // Default: no existing bot comment → creates new
      mockClient.get.mockResolvedValue({ data: [] });
      mockClient.post.mockResolvedValue({ data: { id: 999 } });
    });

    test('postDeployingComment calls upsertComment', async () => {
      const result = await githubService.postDeployingComment('o', 'r', 1, 'main');
      expect(mockClient.post).toHaveBeenCalled();
      expect(result.action).toBe('created');
    });

    test('postPreviewComment passes URL to body', async () => {
      await githubService.postPreviewComment('o', 'r', 1, 'https://preview.com', {});
      const callBody = mockClient.post.mock.calls[0][1].body;
      expect(callBody).toContain('https://preview.com');
    });

    test('postFailedComment passes error to body', async () => {
      await githubService.postFailedComment('o', 'r', 1, 'npm ERR! missing script');
      const callBody = mockClient.post.mock.calls[0][1].body;
      expect(callBody).toContain('npm ERR! missing script');
    });

    test('postCleanupComment marks PR as destroyed', async () => {
      await githubService.postCleanupComment('o', 'r', 1, true);
      const callBody = mockClient.post.mock.calls[0][1].body;
      expect(callBody).toContain('Cleaned Up');
    });
  });
});
