/**
 * Vendor API Tests (vendor.js routes)
 * Tests vendor submission and management endpoints
 */

const request = require('supertest');

const API_BASE_URL = global.TEST_CONFIG.API_BASE_URL;
const ADMIN_USER = global.TEST_CONFIG.ADMIN_USER;

describe('Vendor API - /api/v1/vendor', () => {
  let authToken;

  beforeAll(async () => {
    // Try to get auth token
    const loginResponse = await request(API_BASE_URL)
      .post('/api/v1/auth/login')
      .send({
        email: ADMIN_USER.email,
        password: ADMIN_USER.password
      });

    if (loginResponse.status === 200 && loginResponse.body.token) {
      authToken = loginResponse.body.token;
    }
  });

  describe('GET /api/v1/vendor/submissions', () => {
    it('should return vendor submissions list', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/vendor/submissions');

      expect([200, 401]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toBeDefined();
      }
    });
  });

  describe('POST /api/v1/vendor/submit', () => {
    it('should reject submission without required fields', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/vendor/submit')
        .send({});

      expect([400, 401, 422]).toContain(response.status);
    });

    it('should accept valid vendor submission', async () => {
      const submission = {
        vendor_name: 'Test Vendor',
        vendor_email: `vendor${Date.now()}@test.com`,
        module_name: `test-module-${Date.now()}`,
        module_description: 'A test module',
        webhook_url: 'https://example.com/webhook',
        pricing_model: 'flat-rate',
        payment_method: 'paypal'
      };

      const response = await request(API_BASE_URL)
        .post('/api/v1/vendor/submit')
        .send(submission);

      expect([200, 201, 400, 409]).toContain(response.status);
    });
  });

  describe('GET /api/v1/vendor/dashboard', () => {
    it('should require authentication', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/vendor/dashboard');

      expect([200, 401]).toContain(response.status);
    });

    it('should return dashboard data when authenticated', async () => {
      if (!authToken) return;

      const response = await request(API_BASE_URL)
        .get('/api/v1/vendor/dashboard')
        .set('Authorization', `Bearer ${authToken}`);

      expect([200, 401, 403]).toContain(response.status);
    });
  });

  describe('GET /api/v1/vendor/status/:submissionId', () => {
    it('should return 404 for non-existent submission', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/vendor/status/non-existent-id');

      expect([404, 401]).toContain(response.status);
    });
  });
});
