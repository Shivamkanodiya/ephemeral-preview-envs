// ============================================
// Render Service Tests
// ============================================
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    interceptors: {
      response: { use: jest.fn() },
      request: { use: jest.fn() },
    },
  })),
}));

beforeEach(() => {
  jest.resetModules();
});

describe('RenderService', () => {
  describe('generateServiceName', () => {
    test('generates correct name format', () => {
      const renderService = require('../services/render.service');
      const name = renderService.generateServiceName(42);
      expect(name).toBe('preview-pr-42');
    });

    test('handles different PR numbers', () => {
      const renderService = require('../services/render.service');
      expect(renderService.generateServiceName(1)).toBe('preview-pr-1');
      expect(renderService.generateServiceName(999)).toBe('preview-pr-999');
    });
  });

  describe('generateExpectedUrl', () => {
    test('generates correct URL format', () => {
      const renderService = require('../services/render.service');
      const url = renderService.generateExpectedUrl(42);
      expect(url).toBe('https://preview-pr-42.onrender.com');
    });
  });
});
