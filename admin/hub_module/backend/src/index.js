/**
 * Hub Module - Express Application Entry Point
 * Unified Community Portal and Admin Interface
 */
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import bcrypt from 'bcrypt';
import { config } from './config/index.js';
import { checkConnection, closePool, query } from './config/database.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { sanitizeBody } from './middleware/validation.js';
import { setCsrfToken, verifyCsrfToken } from './middleware/csrf.js';
import routes from './routes/index.js';
import { setupWebSocket } from './websocket/index.js';

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

    // Create hub_users table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_users (
        id SERIAL PRIMARY KEY,
        display_name VARCHAR(255),
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `);

    // Create hub_user_identities table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_user_identities (
        id SERIAL PRIMARY KEY,
        hub_user_id INTEGER NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        platform VARCHAR(50) NOT NULL,
        platform_user_id VARCHAR(255) NOT NULL,
        platform_username VARCHAR(255),
        avatar_url TEXT,
        is_primary BOOLEAN DEFAULT false,
        linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used TIMESTAMP,
        UNIQUE(hub_user_id, platform),
        UNIQUE(platform, platform_user_id)
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
        reputation INTEGER DEFAULT 600,
        is_active BOOLEAN DEFAULT true,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(community_id, platform, platform_user_id)
      )
    `);

    // Create hub_chat_messages table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_chat_messages (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL,
        channel_name VARCHAR(255),
        sender_hub_user_id INTEGER,
        sender_platform VARCHAR(50),
        sender_username VARCHAR(255),
        sender_avatar_url TEXT,
        message_content TEXT NOT NULL,
        message_type VARCHAR(50) DEFAULT 'text',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for chat messages
    await query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_community
      ON hub_chat_messages(community_id, created_at DESC)
    `);

    // Create hub_modules table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_modules (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255),
        description TEXT,
        version VARCHAR(50),
        author VARCHAR(255),
        category VARCHAR(100),
        icon_url TEXT,
        is_published BOOLEAN DEFAULT false,
        is_core BOOLEAN DEFAULT false,
        config_schema JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create hub_module_installations table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_module_installations (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL,
        module_id INTEGER REFERENCES hub_modules(id),
        installed_by INTEGER,
        config JSONB DEFAULT '{}',
        is_enabled BOOLEAN DEFAULT true,
        installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(community_id, module_id)
      )
    `);

    // Create hub_module_reviews table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS hub_module_reviews (
        id SERIAL PRIMARY KEY,
        module_id INTEGER REFERENCES hub_modules(id),
        community_id INTEGER,
        user_id INTEGER,
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        review_text TEXT,
        admin_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create announcements table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        announcement_type VARCHAR(50) DEFAULT 'general',
        priority INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'published',
        is_pinned BOOLEAN DEFAULT false,
        broadcast_to_platforms BOOLEAN DEFAULT false,
        broadcasted_platforms JSONB DEFAULT '[]',
        created_by INTEGER REFERENCES hub_users(id),
        created_by_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_by INTEGER REFERENCES hub_users(id),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMP,
        archived_at TIMESTAMP
      )
    `);

    // Create index for announcements
    await query(`
      CREATE INDEX IF NOT EXISTS idx_announcements_community
      ON announcements(community_id, created_at DESC)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_announcements_pinned
      ON announcements(community_id, is_pinned, created_at DESC)
    `);

    // Create announcement_broadcasts table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS announcement_broadcasts (
        id SERIAL PRIMARY KEY,
        announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        community_server_id INTEGER,
        platform VARCHAR(50) NOT NULL,
        channel_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        platform_message_id VARCHAR(255),
        error_message TEXT,
        broadcasted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for announcement broadcasts
    await query(`
      CREATE INDEX IF NOT EXISTS idx_announcement_broadcasts_announcement
      ON announcement_broadcasts(announcement_id)
    `);

    // Create community_overlay_tokens table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS community_overlay_tokens (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        overlay_key VARCHAR(64) NOT NULL UNIQUE,
        previous_key VARCHAR(64),
        is_active BOOLEAN DEFAULT true,
        theme_config JSONB DEFAULT '{}',
        enabled_sources JSONB DEFAULT '["alerts", "chat", "goals", "ticker"]',
        last_accessed TIMESTAMP,
        access_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rotated_at TIMESTAMP,
        UNIQUE(community_id)
      )
    `);

    // Create overlay_access_log table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS overlay_access_log (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL,
        overlay_key VARCHAR(64),
        ip_address VARCHAR(45),
        user_agent TEXT,
        accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for overlay access log
    await query(`
      CREATE INDEX IF NOT EXISTS idx_overlay_access_log_community
      ON overlay_access_log(community_id, accessed_at DESC)
    `);

    // Create analytics_bot_scores table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS analytics_bot_scores (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
        grade VARCHAR(1) NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
        bad_actor_score INTEGER DEFAULT 0,
        reputation_score INTEGER DEFAULT 0,
        security_score INTEGER DEFAULT 0,
        ai_behavioral_score INTEGER DEFAULT 0,
        suspected_bot_count INTEGER DEFAULT 0,
        high_confidence_bot_count INTEGER DEFAULT 0,
        total_users_analyzed INTEGER DEFAULT 0,
        community_size_category VARCHAR(20) DEFAULT 'small',
        calculation_metadata JSONB DEFAULT '{}',
        calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(community_id)
      )
    `);

    // Create index for bot scores
    await query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_bot_scores_community
      ON analytics_bot_scores(community_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_bot_scores_grade
      ON analytics_bot_scores(grade)
    `);

    // Create analytics_suspected_bots table for detailed bot analysis
    await query(`
      CREATE TABLE IF NOT EXISTS analytics_suspected_bots (
        id SERIAL PRIMARY KEY,
        community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        platform VARCHAR(50) NOT NULL,
        platform_user_id VARCHAR(255) NOT NULL,
        username VARCHAR(255),
        confidence_score INTEGER NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 100),
        detection_reasons JSONB DEFAULT '[]',
        ai_analysis TEXT,
        behavioral_flags JSONB DEFAULT '[]',
        first_detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TIMESTAMP,
        is_confirmed_bot BOOLEAN DEFAULT false,
        is_false_positive BOOLEAN DEFAULT false,
        reviewed_by INTEGER REFERENCES hub_users(id),
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(community_id, platform, platform_user_id)
      )
    `);

    // Create index for suspected bots
    await query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_suspected_bots_community
      ON analytics_suspected_bots(community_id, confidence_score DESC)
    `);

    // Check if default admin exists in hub_users (unified auth system)
    const adminCheck = await query(
      'SELECT id FROM hub_users WHERE email = $1',
      ['admin@localhost.net']
    );

    if (adminCheck.rows.length === 0) {
      // Create default admin with password 'admin123'
      const passwordHash = await bcrypt.hash('admin123', 12);
      const adminResult = await query(
        `INSERT INTO hub_users (email, username, password_hash, is_super_admin, is_active, email_verified)
         VALUES ($1, $2, $3, true, true, true)
         RETURNING id`,
        ['admin@localhost.net', 'admin', passwordHash]
      );
      const adminId = adminResult.rows[0].id;
      logger.system('Default admin user created (email: admin@localhost.net, password: admin123)');

      // Add admin to global community if it exists
      const globalCommunity = await query(
        'SELECT id FROM communities WHERE is_global = true LIMIT 1'
      );
      if (globalCommunity.rows.length > 0) {
        await query(
          `INSERT INTO community_members (community_id, user_id, role, is_active, joined_at)
           VALUES ($1, $2, 'member', true, NOW())
           ON CONFLICT (community_id, user_id) DO NOTHING`,
          [globalCommunity.rows[0].id, adminId]
        );
        // Update member count
        await query(
          `UPDATE communities SET member_count = (
            SELECT COUNT(*) FROM community_members WHERE community_id = $1 AND is_active = true
          ) WHERE id = $1`,
          [globalCommunity.rows[0].id]
        );
        logger.system('Admin user added to global community');
      }
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
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline for React dev
      styleSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline for Tailwind/inline styles
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"], // WebSocket support
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for OBS browser source
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
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

// Cookie parsing (required for CSRF tokens)
app.use(cookieParser());

// XSS protection - sanitize all string inputs
app.use(sanitizeBody);

// CSRF protection for state-changing requests
// Set CSRF token for all requests
app.use(setCsrfToken);
// Verify CSRF token on POST/PUT/PATCH/DELETE
app.use(verifyCsrfToken);

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

// Metrics endpoint (for internal monitoring)
app.get('/metrics', async (req, res) => {
  const { getPoolMetrics } = await import('./config/database.js');
  const poolMetrics = getPoolMetrics();

  res.json({
    module: 'hub_module',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    database: {
      pool: poolMetrics,
      health: await checkConnection(),
    },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// API routes
app.use('/api/v1', routes);

// Serve frontend static files (both production and development)
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

// 404 handler for API routes
app.use('/api/', notFoundHandler);

// Global error handler
app.use(errorHandler);

// Create HTTP server for Express and Socket.io
const httpServer = createServer(app);

// Graceful shutdown
async function shutdown(signal, io) {
  logger.system(`${signal} received, shutting down gracefully`);

  // Close Socket.io connections
  if (io) {
    io.close();
  }

  // Close HTTP server
  httpServer.close();

  // Close database pool
  await closePool();

  process.exit(0);
}

// Start server
async function start() {
  // Initialize database tables and default admin
  await initializeDatabase();

  // Setup WebSocket
  const io = setupWebSocket(httpServer);

  // Start HTTP server
  httpServer.listen(config.port, config.host, () => {
    logger.system('Hub module started', {
      port: config.port,
      host: config.host,
      env: config.env,
      websocket: 'enabled',
    });
  });

  // Handle server errors
  httpServer.on('error', (err) => {
    logger.error('Server error', { error: err.message });
    process.exit(1);
  });

  // Setup graceful shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM', io));
  process.on('SIGINT', () => shutdown('SIGINT', io));
}

start().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});

export default app;
