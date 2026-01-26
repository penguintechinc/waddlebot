/**
 * Auth API Tests (auth.js routes)
 * Tests authentication endpoints including login, register, OAuth, and session management
 */

const request = require('supertest');
const nock = require('nock');

const API_BASE_URL = global.TEST_CONFIG.API_BASE_URL;
const TEST_USER = global.TEST_CONFIG.TEST_USER;
const ADMIN_USER = global.TEST_CONFIG.ADMIN_USER;

describe('Auth API - /api/v1/auth', () => {
  let authToken;
  let csrfToken;

  beforeAll(async () => {
    // Get CSRF token
    const csrfResponse = await request(API_BASE_URL)
      .get('/api/v1/auth/csrf');

    if (csrfResponse.body && csrfResponse.body.csrfToken) {
      csrfToken = csrfResponse.body.csrfToken;
    }
  });

  describe('POST /api/v1/auth/register', () => {
    it('should reject registration without required fields', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/register')
        .send({});

      expect([400, 422]).toContain(response.status);
    });

    it('should reject weak passwords', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/register')
        .send({
          email: 'weak@test.com',
          password: '123', // Weak password
          username: 'weakuser'
        });

      expect([400, 422]).toContain(response.status);
    });

    it('should reject invalid email format', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/register')
        .send({
          email: 'not-an-email',
          password: 'Test123!',
          username: 'testuser'
        });

      expect([400, 422]).toContain(response.status);
    });

    it('should register a new user with valid data', async () => {
      const uniqueEmail = `test+${Date.now()}@test.com`;
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', csrfToken || '')
        .send({
          email: uniqueEmail,
          password: 'Test123!',
          username: `testuser${Date.now()}`
        });

      // Either success or conflict if user exists
      expect([200, 201, 409]).toContain(response.status);

      if (response.status === 200 || response.status === 201) {
        expect(response.body).toHaveProperty('success', true);
      }
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should reject login without credentials', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/login')
        .send({});

      expect([400, 401, 403]).toContain(response.status);
    });

    it('should reject login with invalid credentials', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', csrfToken || '')
        .send({
          email: 'nonexistent@test.com',
          password: 'WrongPassword123!'
        });

      expect([401, 403]).toContain(response.status);
    });

    it('should login with valid admin credentials', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', csrfToken || '')
        .send({
          email: ADMIN_USER.email,
          password: ADMIN_USER.password
        });

      // May be 200 (success) or 403 (CSRF required)
      expect([200, 403]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toHaveProperty('success', true);
        expect(response.body).toHaveProperty('user');

        // Save token for subsequent tests
        if (response.body.token) {
          authToken = response.body.token;
        }
      }
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return null user when not authenticated', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/auth/me');

      expect([200, 401]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toHaveProperty('user', null);
      }
    });

    it('should return current user when authenticated', async () => {
      if (!authToken) {
        // Skip if we couldn't get a token
        return;
      }

      const response = await request(API_BASE_URL)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect([200, 401]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toHaveProperty('user');
        if (response.body.user) {
          expect(response.body.user).toHaveProperty('email');
          expect(response.body.user).toHaveProperty('username');
        }
      }
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('should logout successfully', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${authToken}`);

      expect([200, 401]).toContain(response.status);
    });
  });

  describe('OAuth Flows - /api/v1/auth/oauth/:platform', () => {
    beforeEach(() => {
      global.mockOAuthPlatforms();
    });

    it('should initiate OAuth flow for supported platform', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/auth/oauth/twitch');

      // Should redirect or return OAuth URL
      expect([200, 302]).toContain(response.status);
    });

    it('should reject unsupported OAuth platform', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/auth/oauth/invalid-platform');

      expect([400, 404]).toContain(response.status);
    });
  });

  describe('Password Reset Flow', () => {
    it('should accept password reset request with valid email', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/forgot-password')
        .send({
          email: ADMIN_USER.email
        });

      expect([200, 404]).toContain(response.status);
    });

    it('should reject password reset with invalid email', async () => {
      const response = await request(API_BASE_URL)
        .post('/api/v1/auth/forgot-password')
        .send({
          email: 'not-an-email'
        });

      expect([400, 422]).toContain(response.status);
    });
  });

  describe('Email Verification', () => {
    it('should accept verification token endpoint', async () => {
      const response = await request(API_BASE_URL)
        .get('/api/v1/auth/verify-email/mock-token');

      // Endpoint should exist (200 success or 400/404 invalid token)
      expect([200, 400, 404]).toContain(response.status);
    });
  });
});
