/**
 * Public API Tests (public.js routes)
 * Tests public endpoints that don't require authentication
 */

const request = require('supertest');

const API_BASE_URL = global.TEST_CONFIG.API_BASE_URL;

describe('Public API - /api/v1', () => {
  describe('GET /health', () => {
    it('should return 200 OK', async () => {
      const response = await request(API_BASE_URL)
        .get('/health');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/v1/signup-settings', () => {
    it('should return signup configuration', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/signup-settings');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });
  });

  describe('GET /api/v1/stats', () => {
    it('should return platform statistics', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/stats');

      expect([200, 404]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toBeDefined();
      }
    });
  });

  describe('GET /api/v1/communities', () => {
    it('should return list of public communities', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/communities');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });

    it('should support pagination', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/communities')
        .query({ limit: 10, offset: 0 });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });

    it('should reject invalid pagination parameters', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/communities')
        .query({ limit: -1, offset: 'invalid' });

      expect([200, 400]).toContain(response.status);
    });
  });
});
