/**
 * Database Integration Tests
 * Tests database transactions, cross-table operations, and data consistency
 */

const { Client } = require('pg');
const Redis = require('ioredis');

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'waddlebot',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
};

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
};

describe('Database Integration Tests', () => {
  let pgClient;
  let redisClient;

  beforeAll(async () => {
    pgClient = new Client(DB_CONFIG);
    await pgClient.connect();

    redisClient = new Redis(REDIS_CONFIG);
  });

  afterAll(async () => {
    await pgClient.end();
    await redisClient.quit();
  });

  describe('PostgreSQL Connection', () => {
    it('should connect to database', async () => {
      const result = await pgClient.query('SELECT 1 as test');
      expect(result.rows[0].test).toBe(1);
    });

    it('should have required tables', async () => {
      const tables = [
        'hub_users',
        'hub_sessions',
        'communities',
        'community_members',
        'hub_settings',
        'cookie_policy_versions'
      ];

      for (const table of tables) {
        const result = await pgClient.query(
          `SELECT to_regclass('public.${table}') as exists`
        );
        expect(result.rows[0].exists).toBeTruthy();
      }
    });
  });

  describe('Redis Connection', () => {
    it('should connect to Redis', async () => {
      const result = await redisClient.ping();
      expect(result).toBe('PONG');
    });

    it('should set and get values', async () => {
      const key = `test:${Date.now()}`;
      await redisClient.set(key, 'test-value', 'EX', 60);
      const value = await redisClient.get(key);
      expect(value).toBe('test-value');
      await redisClient.del(key);
    });
  });

  describe('Cross-Table Transactions', () => {
    it('should maintain referential integrity on user delete', async () => {
      // Create test user
      const userResult = await pgClient.query(
        `INSERT INTO hub_users (email, username, is_active)
         VALUES ($1, $2, true) RETURNING id`,
        [`test${Date.now()}@test.com`, `testuser${Date.now()}`]
      );
      const userId = userResult.rows[0].id;

      // Create session for user
      await pgClient.query(
        `INSERT INTO hub_sessions (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [userId, `token${Date.now()}`]
      );

      // Delete user (should cascade to sessions)
      await pgClient.query('DELETE FROM hub_users WHERE id = $1', [userId]);

      // Verify session was deleted
      const sessionResult = await pgClient.query(
        'SELECT * FROM hub_sessions WHERE user_id = $1',
        [userId]
      );
      expect(sessionResult.rows.length).toBe(0);
    });
  });

  describe('Data Consistency', () => {
    it('should enforce unique constraints', async () => {
      const email = `unique${Date.now()}@test.com`;

      // Create first user
      await pgClient.query(
        `INSERT INTO hub_users (email, username, is_active)
         VALUES ($1, $2, true)`,
        [email, `user1${Date.now()}`]
      );

      // Attempt to create duplicate
      await expect(
        pgClient.query(
          `INSERT INTO hub_users (email, username, is_active)
           VALUES ($1, $2, true)`,
          [email, `user2${Date.now()}`]
        )
      ).rejects.toThrow();

      // Cleanup
      await pgClient.query('DELETE FROM hub_users WHERE email = $1', [email]);
    });
  });
});
