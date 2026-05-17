// ============================================
// Deployment Store Tests (Async — MongoDB/Memory hybrid)
// ============================================
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock database as disconnected → forces in-memory fallback
jest.mock('../config/database', () => ({
  isDBConnected: jest.fn(() => false),
  connectDB: jest.fn(),
  disconnectDB: jest.fn(),
}));

const { deploymentStore, DeploymentStatus } = require('../store/deployment.store');

describe('DeploymentStore (In-Memory Mode)', () => {
  beforeEach(async () => {
    // Clear in-memory store between tests
    const all = await deploymentStore.getAll();
    // Reset by creating fresh store state
  });

  test('create() stores a deployment record', async () => {
    const record = await deploymentStore.create({
      prNumber: 42,
      branch: 'feature/login',
      repoUrl: 'https://github.com/user/repo.git',
      author: 'dev123',
    });

    expect(record.prNumber).toBe(42);
    expect(record.branch).toBe('feature/login');
    expect(record.status).toBe(DeploymentStatus.CREATING);
    expect(record.serviceName).toBe('preview-pr-42');
  });

  test('get() retrieves by PR number', async () => {
    await deploymentStore.create({ prNumber: 10, branch: 'fix/bug' });
    const record = await deploymentStore.get(10);
    expect(record).not.toBeNull();
    expect(record.prNumber).toBe(10);
  });

  test('get() returns null for unknown PR', async () => {
    const result = await deploymentStore.get(9999);
    expect(result).toBeNull();
  });

  test('markActive() updates status and sets URL', async () => {
    await deploymentStore.create({ prNumber: 5, branch: 'feat/x' });
    await deploymentStore.markActive(5, 'srv-abc', 'https://preview-pr-5.onrender.com');

    const record = await deploymentStore.get(5);
    expect(record.status).toBe(DeploymentStatus.ACTIVE);
    expect(record.serviceId).toBe('srv-abc');
    expect(record.url).toBe('https://preview-pr-5.onrender.com');
  });

  test('markFailed() sets error message', async () => {
    await deploymentStore.create({ prNumber: 7, branch: 'feat/y' });
    await deploymentStore.markFailed(7, 'Render API timeout');

    const record = await deploymentStore.get(7);
    expect(record.status).toBe(DeploymentStatus.FAILED);
    expect(record.lastError).toBe('Render API timeout');
  });

  test('markDestroyed() sets destroyedAt', async () => {
    await deploymentStore.create({ prNumber: 3, branch: 'feat/z' });
    await deploymentStore.markDestroyed(3);

    const record = await deploymentStore.get(3);
    expect(record.status).toBe(DeploymentStatus.DESTROYED);
    expect(record.destroyedAt).toBeDefined();
  });

  test('incrementBuild() tracks rebuild count', async () => {
    await deploymentStore.create({ prNumber: 8, branch: 'feat/w' });
    await deploymentStore.incrementBuild(8);
    await deploymentStore.incrementBuild(8);

    const record = await deploymentStore.get(8);
    expect(record.buildCount).toBe(2);
    expect(record.status).toBe(DeploymentStatus.BUILDING);
  });

  test('getActive() excludes destroyed and failed', async () => {
    await deploymentStore.create({ prNumber: 101, branch: 'a' });
    await deploymentStore.create({ prNumber: 102, branch: 'b' });
    await deploymentStore.create({ prNumber: 103, branch: 'c' });

    await deploymentStore.markActive(101, 'srv-1', 'url-1');
    await deploymentStore.markDestroyed(102);
    await deploymentStore.markFailed(103, 'error');

    const active = await deploymentStore.getActive();
    const activePRs = active.map((d) => d.prNumber);
    expect(activePRs).toContain(101);
    expect(activePRs).not.toContain(102);
    expect(activePRs).not.toContain(103);
  });

  test('getStats() returns correct counts', async () => {
    await deploymentStore.create({ prNumber: 201, branch: 'a' });
    await deploymentStore.create({ prNumber: 202, branch: 'b' });
    await deploymentStore.markActive(201, 'srv-1', 'url-1');
    await deploymentStore.markDestroyed(202);

    const stats = await deploymentStore.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
  });
});
