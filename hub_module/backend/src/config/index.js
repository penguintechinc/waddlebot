/**
 * Hub Module Configuration
 * Loads environment variables and provides typed configuration object.
 */
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '8060', 10),
  host: process.env.HOST || '0.0.0.0',

  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgresql://waddlebot:password@localhost:5432/waddlebot',
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '3600', 10),
  },

  // Session
  session: {
    ttl: parseInt(process.env.SESSION_TTL || '3600', 10),
  },

  // Temp Password
  tempPassword: {
    expiresHours: parseInt(process.env.TEMP_PASSWORD_EXPIRES_HOURS || '48', 10),
  },

  // OAuth / Identity
  identity: {
    apiUrl: process.env.IDENTITY_API_URL || 'http://identity-core:8050',
    callbackBaseUrl: process.env.OAUTH_CALLBACK_BASE_URL || 'http://localhost:8060',
  },

  // Module Integration
  modules: {
    router: process.env.ROUTER_API_URL || 'http://router:8000',
    reputation: process.env.REPUTATION_API_URL || 'http://reputation:8021',
    labels: process.env.LABELS_API_URL || 'http://labels-core:8023',
    inventory: process.env.INVENTORY_API_URL || 'http://inventory:8024',
    calendar: process.env.CALENDAR_API_URL || 'http://calendar:8030',
    memories: process.env.MEMORIES_API_URL || 'http://memories:8031',
    browserSource: process.env.BROWSER_SOURCE_API_URL || 'http://browser-source:8027',
  },

  // Custom Domains
  baseDomain: process.env.BASE_DOMAIN || 'waddlebot.io',
  blockedSubdomains: [
    'www', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'api', 'admin', 'portal', 'hub',
    'app', 'dashboard', 'status', 'docs', 'help', 'support', 'billing',
    'cdn', 'static', 'assets', 'media', 'img', 'images', 'dev', 'staging',
    'test', 'demo', 'beta', 'auth', 'login', 'oauth', 'sso', 'identity',
  ],

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || '/var/log/waddlebotlog',
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};

export default config;
