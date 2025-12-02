/**
 * Hub Module - Express Application Entry Point
 * Unified Community Portal and Admin Interface
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import bcrypt from 'bcrypt';
import { config } from './config/index.js';
import { checkConnection, closePool, query } from './config/database.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

/**
 * Initialize database tables and default admin
 */
async function initializeDatabase() {
  try {
    // Create hub_admins table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        is_super_admin BOOLEAN DEFAULT false,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create hub_sessions table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_sessions (
        id SERIAL PRIMARY KEY,
        session_token TEXT NOT NULL,
        user_id INTEGER,
        platform VARCHAR(50),
        platform_user_id VARCHAR(255),
        platform_username VARCHAR(255),
        avatar_url TEXT,
        is_active BOOLEAN DEFAULT true,
        expires_at TIMESTAMP,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create hub_temp_passwords table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_temp_passwords (
        id SERIAL PRIMARY KEY,
        user_identifier VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        community_id INTEGER,
        force_oauth_link BOOLEAN DEFAULT false,
        linked_oauth_platform VARCHAR(50),
        linked_oauth_user_id VARCHAR(255),
        is_used BOOLEAN DEFAULT false,
        used_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create communities table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS communities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255),
        description TEXT,
        logo_url TEXT,
        banner_url TEXT,
        primary_platform VARCHAR(50) NOT NULL DEFAULT 'discord',
        platform VARCHAR(50) NOT NULL DEFAULT 'discord',
        platform_server_id VARCHAR(255),
        owner_id VARCHAR(255),
        owner_name VARCHAR(255),
        member_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        is_public BOOLEAN DEFAULT true,
        config JSONB DEFAULT '{}',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP,
        deleted_by VARCHAR(255)
      )
    `);

    // Create community_members table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS community_members (
        id SERIAL PRIMARY KEY,
        community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
        user_id VARCHAR(255),
        platform VARCHAR(50) NOT NULL,
        platform_user_id VARCHAR(255),
        display_name VARCHAR(255),
        avatar_url TEXT,
        role VARCHAR(50) DEFAULT 'member',
        reputation_score INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(community_id, platform, platform_user_id)
      )
    `);

    // Check if default admin exists
    const adminCheck = await query(
      'SELECT id FROM hub_admins WHERE username = $1',
      ['admin']
    );

    if (adminCheck.rows.length === 0) {
      // Create default admin with password 'admin123'
      const passwordHash = await bcrypt.hash('admin123', 12);
      await query(
        `INSERT INTO hub_admins (username, password_hash, email, is_super_admin)
         VALUES ($1, $2, $3, $4)`,
        ['admin', passwordHash, 'admin@waddlebot.local', true]
      );
      logger.system('Default admin user created (username: admin, password: admin123)');
    }

    logger.system('Database initialized successfully');
  } catch (err) {
    logger.error('Database initialization failed', { error: err.message });
    throw err;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Express app
const app = express();

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development, configure properly in production
}));

// CORS
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Only log API requests, not static files
    if (req.path.startsWith('/api/') || req.path === '/health') {
      logger.http(req, res, duration);
    }
  });
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbHealthy = await checkConnection();
  const status = dbHealthy ? 'healthy' : 'degraded';

  res.status(dbHealthy ? 200 : 503).json({
    module: 'hub_module',
    version: '1.0.0',
    status,
    timestamp: new Date().toISOString(),
    database: dbHealthy ? 'connected' : 'disconnected',
  });
});

// API routes
app.use('/api/v1', routes);

// Serve frontend static files in production
if (config.env === 'production') {
  // In Docker, frontend is built to /app/public; in dev, use relative path
  const frontendPath = process.env.STATIC_PATH || path.join(__dirname, '../public');
  app.use(express.static(frontendPath));

  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// 404 handler for API routes
app.use('/api/', notFoundHandler);

// Global error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown(signal) {
  logger.system(`${signal} received, shutting down gracefully`);

  // Close database pool
  await closePool();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  // Initialize database tables and default admin
  await initializeDatabase();

  const server = app.listen(config.port, config.host, () => {
    logger.system('Hub module started', {
      port: config.port,
      host: config.host,
      env: config.env,
    });
  });

  // Handle server errors
  server.on('error', (err) => {
    logger.error('Server error', { error: err.message });
    process.exit(1);
  });
}

start().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});

export default app;
