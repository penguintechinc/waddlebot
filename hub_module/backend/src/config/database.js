/**
 * Database Configuration
 * PostgreSQL connection pool using node-postgres (pg).
 */
import pg from 'pg';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

// Parse connection URL and create pool
const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolSize,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Connection event handlers
pool.on('connect', () => {
  logger.debug('New database connection established');
});

pool.on('error', (err) => {
  logger.error('Unexpected database error', { error: err.message });
});

/**
 * Execute a query with parameters
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', {
      query: text.substring(0, 100),
      duration: `${duration}ms`,
      rows: result.rowCount
    });
    return result;
  } catch (error) {
    logger.error('Query error', {
      query: text.substring(0, 100),
      error: error.message
    });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<pg.PoolClient>}
 */
export async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);

  // Override release to log
  client.release = () => {
    logger.debug('Database client released');
    return originalRelease();
  };

  return client;
}

/**
 * Execute a transaction with automatic rollback on error
 * @param {Function} callback - Async function receiving client
 * @returns {Promise<any>}
 */
export async function transaction(callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check database connectivity
 * @returns {Promise<boolean>}
 */
export async function checkConnection() {
  try {
    const result = await query('SELECT NOW()');
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Close all pool connections
 */
export async function closePool() {
  await pool.end();
  logger.info('Database pool closed');
}

export { pool };
export default { query, getClient, transaction, checkConnection, closePool, pool };
