// ============================================
// Health Route Tests (Updated for store integration)
// ============================================
const request = require('supertest');

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const app = require('../app');

describe('Health Check Endpoint', () => {
  test('GET /api/health returns 200 with status info', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('ephemeral-preview-envs');
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.uptime).toBeDefined();
    expect(res.body.memory).toBeDefined();
    expect(res.body.deployments).toBeDefined();
    expect(res.body.deployments.total).toBeDefined();
  });

  test('Unknown route returns 404', async () => {
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });

  test('GET /api/previews returns deployment list', async () => {
    const res = await request(app).get('/api/previews');
    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.deployments).toBeInstanceOf(Array);
  });

  test('GET /api/previews/audit returns full history', async () => {
    const res = await request(app).get('/api/previews/audit');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeDefined();
    expect(res.body.deployments).toBeInstanceOf(Array);
  });

  test('GET /api/previews/abc returns 400 for invalid PR number', async () => {
    const res = await request(app).get('/api/previews/abc');
    expect(res.status).toBe(400);
  });

  test('DELETE /api/previews/abc returns 400 for invalid PR number', async () => {
    const res = await request(app).delete('/api/previews/abc');
    expect(res.status).toBe(400);
  });
});
