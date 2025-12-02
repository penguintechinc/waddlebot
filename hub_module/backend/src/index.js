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

import { config } from './config/index.js';
import { checkConnection, closePool } from './config/database.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

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

export default app;
