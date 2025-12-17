/**
 * Service Discovery Controller
 * Handles microservice health monitoring and service registry
 */
import { query } from '../db.js';

/**
 * Default WaddleBot services based on docker-compose
 */
const DEFAULT_SERVICES = [
  // Infrastructure Services
  {
    name: 'PostgreSQL',
    description: 'Primary database for WaddleBot',
    category: 'infrastructure',
    url: 'postgres',
    port: 5432,
    protocol: 'tcp',
    healthEndpoint: null,
    dependencies: [],
    environment: { version: '15-alpine' }
  },
  {
    name: 'Redis',
    description: 'In-memory cache and message broker',
    category: 'infrastructure',
    url: 'redis',
    port: 6379,
    protocol: 'tcp',
    healthEndpoint: null,
    dependencies: [],
    environment: { version: '7-alpine' }
  },
  {
    name: 'MinIO',
    description: 'S3-compatible object storage',
    category: 'infrastructure',
    url: 'minio',
    port: 9000,
    protocol: 'http',
    healthEndpoint: '/minio/health/live',
    dependencies: [],
    environment: { version: '2024-01-16' }
  },
  {
    name: 'Kong API Gateway',
    description: 'API gateway and load balancer',
    category: 'infrastructure',
    url: 'kong',
    port: 8000,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL'],
    environment: { version: '3.5' }
  },
  {
    name: 'Ollama',
    description: 'Local AI inference server',
    category: 'infrastructure',
    url: 'ollama',
    port: 11434,
    protocol: 'http',
    healthEndpoint: '/api/tags',
    dependencies: [],
    environment: { version: 'latest' }
  },
  {
    name: 'Qdrant',
    description: 'Vector database for AI memory',
    category: 'infrastructure',
    url: 'qdrant',
    port: 6333,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: [],
    environment: { version: 'latest' }
  },
  {
    name: 'OpenWhisk',
    description: 'Serverless functions platform',
    category: 'infrastructure',
    url: 'openwhisk',
    port: 3233,
    protocol: 'http',
    healthEndpoint: '/api/v1',
    dependencies: [],
    environment: { version: 'nightly' }
  },
  // Core Services
  {
    name: 'Hub Admin',
    description: 'Central administration portal',
    category: 'admin',
    url: 'hub',
    port: 8060,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis', 'MinIO'],
    environment: {}
  },
  {
    name: 'Router',
    description: 'Message routing and event processing',
    category: 'processing',
    url: 'router',
    port: 8000,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis'],
    environment: {}
  },
  {
    name: 'Identity Core',
    description: 'User identity and authentication',
    category: 'core',
    url: 'identity-core',
    port: 8050,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis', 'Router'],
    environment: {}
  },
  {
    name: 'Browser Source',
    description: 'OBS overlay and browser source management',
    category: 'core',
    url: 'browser-source',
    port: 8027,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Router'],
    environment: {}
  },
  {
    name: 'Labels Core',
    description: 'Label and tag management system',
    category: 'core',
    url: 'labels-core',
    port: 8023,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis', 'Router'],
    environment: {}
  },
  {
    name: 'Workflow Core',
    description: 'Workflow automation engine',
    category: 'core',
    url: 'workflow-core',
    port: 8070,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis', 'Router'],
    environment: {}
  },
  {
    name: 'Analytics Core',
    description: 'Analytics and metrics collection',
    category: 'core',
    url: 'analytics-core',
    port: 8040,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis'],
    environment: {}
  },
  {
    name: 'Security Core',
    description: 'Security and access control',
    category: 'core',
    url: 'security-core',
    port: 8041,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis'],
    environment: {}
  },
  {
    name: 'AI Researcher',
    description: 'AI-powered research and knowledge management',
    category: 'core',
    url: 'ai-researcher',
    port: 8070,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['PostgreSQL', 'Redis', 'Qdrant', 'Ollama'],
    environment: {}
  },
  // Trigger/Collector Services
  {
    name: 'Twitch Collector',
    description: 'Twitch event collector',
    category: 'triggers',
    url: 'twitch-collector',
    port: 8002,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Discord Collector',
    description: 'Discord event collector',
    category: 'triggers',
    url: 'discord-collector',
    port: 8003,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Slack Collector',
    description: 'Slack event collector',
    category: 'triggers',
    url: 'slack-collector',
    port: 8004,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'YouTube Live Collector',
    description: 'YouTube Live event collector',
    category: 'triggers',
    url: 'youtube-live-collector',
    port: 8006,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Kick Collector',
    description: 'Kick event collector',
    category: 'triggers',
    url: 'kick-collector',
    port: 8007,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  // Action Services
  {
    name: 'AI Interaction',
    description: 'AI-powered chat interactions',
    category: 'actions',
    url: 'ai-interaction',
    port: 8005,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'Ollama'],
    environment: {}
  },
  {
    name: 'Alias Interaction',
    description: 'Command alias management',
    category: 'actions',
    url: 'alias-interaction',
    port: 8010,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Shoutout Interaction',
    description: 'Streamer shoutout system',
    category: 'actions',
    url: 'shoutout-interaction',
    port: 8011,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Inventory Interaction',
    description: 'Virtual inventory management',
    category: 'actions',
    url: 'inventory-interaction',
    port: 8024,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Calendar Interaction',
    description: 'Event and calendar management',
    category: 'actions',
    url: 'calendar-interaction',
    port: 8030,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Memories Interaction',
    description: 'User memories and history',
    category: 'actions',
    url: 'memories-interaction',
    port: 8031,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Loyalty Interaction',
    description: 'Loyalty points and rewards',
    category: 'actions',
    url: 'loyalty-interaction',
    port: 8032,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'YouTube Music',
    description: 'YouTube music integration',
    category: 'actions',
    url: 'youtube-music',
    port: 8025,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'Browser Source'],
    environment: {}
  },
  {
    name: 'Spotify Interaction',
    description: 'Spotify music integration',
    category: 'actions',
    url: 'spotify-interaction',
    port: 8026,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'Browser Source'],
    environment: {}
  },
  {
    name: 'Discord Action',
    description: 'Discord message sending',
    category: 'actions',
    url: 'discord-action',
    port: 8070,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL'],
    environment: {}
  },
  {
    name: 'Slack Action',
    description: 'Slack message sending',
    category: 'actions',
    url: 'slack-action',
    port: 8071,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL'],
    environment: {}
  },
  {
    name: 'Twitch Action',
    description: 'Twitch chat and API actions',
    category: 'actions',
    url: 'twitch-action',
    port: 8072,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL'],
    environment: {}
  },
  {
    name: 'YouTube Action',
    description: 'YouTube API actions',
    category: 'actions',
    url: 'youtube-action',
    port: 8073,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL'],
    environment: {}
  },
  {
    name: 'Lambda Action',
    description: 'AWS Lambda serverless actions',
    category: 'actions',
    url: 'lambda-action',
    port: 8080,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL'],
    environment: {}
  },
  {
    name: 'GCP Functions Action',
    description: 'Google Cloud Functions actions',
    category: 'actions',
    url: 'gcp-functions-action',
    port: 8081,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL'],
    environment: {}
  },
  {
    name: 'OpenWhisk Action',
    description: 'OpenWhisk serverless actions',
    category: 'actions',
    url: 'openwhisk-action',
    port: 8082,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router', 'PostgreSQL', 'OpenWhisk'],
    environment: {}
  },
  // Supporting Services
  {
    name: 'Community',
    description: 'Community management',
    category: 'core',
    url: 'community',
    port: 8020,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  },
  {
    name: 'Reputation',
    description: 'User reputation system',
    category: 'core',
    url: 'reputation',
    port: 8021,
    protocol: 'http',
    healthEndpoint: '/health',
    dependencies: ['Router'],
    environment: {}
  }
];

/**
 * Get all registered services
 */
export async function getServices(req, res) {
  try {
    // First, ensure default services are populated
    await ensureDefaultServices();

    const result = await query(
      `SELECT * FROM services ORDER BY category, name`
    );

    res.json({
      success: true,
      services: result.rows.map(formatService),
    });
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch services',
    });
  }
}

/**
 * Get a specific service by ID
 */
export async function getService(req, res) {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT * FROM services WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    res.json({
      success: true,
      service: formatService(result.rows[0]),
    });
  } catch (error) {
    console.error('Error fetching service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch service',
    });
  }
}

/**
 * Add a new service
 */
export async function addService(req, res) {
  try {
    const {
      name,
      description,
      category,
      url,
      port,
      protocol = 'http',
      healthEndpoint = '/health',
      dependencies = [],
      environment = {},
    } = req.body;

    // Validate required fields
    if (!name || !url || !port || !category) {
      return res.status(400).json({
        success: false,
        message: 'Name, URL, port, and category are required',
      });
    }

    // Validate category
    const validCategories = ['infrastructure', 'core', 'triggers', 'actions', 'processing', 'admin'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `Category must be one of: ${validCategories.join(', ')}`,
      });
    }

    // Check for duplicate name
    const existing = await query(
      `SELECT id FROM services WHERE name = $1`,
      [name]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Service with this name already exists',
      });
    }

    const result = await query(
      `INSERT INTO services
        (name, description, category, url, port, protocol, health_endpoint, status, dependencies, environment, recent_events, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'unknown', $8, $9, '[]'::jsonb, NOW(), NOW())
       RETURNING *`,
      [name, description, category, url, port, protocol, healthEndpoint, JSON.stringify(dependencies), JSON.stringify(environment)]
    );

    res.status(201).json({
      success: true,
      service: formatService(result.rows[0]),
    });
  } catch (error) {
    console.error('Error adding service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add service',
    });
  }
}

/**
 * Update a service
 */
export async function updateService(req, res) {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      category,
      url,
      port,
      protocol,
      healthEndpoint,
      dependencies,
      environment,
    } = req.body;

    // Check if service exists
    const existing = await query(
      `SELECT * FROM services WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }
    if (url !== undefined) {
      updates.push(`url = $${paramCount++}`);
      values.push(url);
    }
    if (port !== undefined) {
      updates.push(`port = $${paramCount++}`);
      values.push(port);
    }
    if (protocol !== undefined) {
      updates.push(`protocol = $${paramCount++}`);
      values.push(protocol);
    }
    if (healthEndpoint !== undefined) {
      updates.push(`health_endpoint = $${paramCount++}`);
      values.push(healthEndpoint);
    }
    if (dependencies !== undefined) {
      updates.push(`dependencies = $${paramCount++}`);
      values.push(JSON.stringify(dependencies));
    }
    if (environment !== undefined) {
      updates.push(`environment = $${paramCount++}`);
      values.push(JSON.stringify(environment));
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(
      `UPDATE services SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json({
      success: true,
      service: formatService(result.rows[0]),
    });
  } catch (error) {
    console.error('Error updating service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update service',
    });
  }
}

/**
 * Delete a service
 */
export async function deleteService(req, res) {
  try {
    const { id } = req.params;

    const result = await query(
      `DELETE FROM services WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    res.json({
      success: true,
      message: 'Service deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete service',
    });
  }
}

/**
 * Refresh health check for a single service
 */
export async function refreshService(req, res) {
  try {
    const { id } = req.params;

    // Get service
    const result = await query(
      `SELECT * FROM services WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    const service = result.rows[0];
    const healthResult = await checkServiceHealth(service);

    // Update service with health check results
    await updateServiceHealth(id, healthResult);

    // Get updated service
    const updated = await query(
      `SELECT * FROM services WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      service: formatService(updated.rows[0]),
    });
  } catch (error) {
    console.error('Error refreshing service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refresh service',
    });
  }
}

/**
 * Refresh health checks for all services
 */
export async function refreshAllServices(req, res) {
  try {
    // Get all services
    const result = await query(`SELECT * FROM services`);
    const services = result.rows;

    // Check health of all services in parallel
    const healthChecks = await Promise.all(
      services.map(async (service) => {
        try {
          const healthResult = await checkServiceHealth(service);
          await updateServiceHealth(service.id, healthResult);
          return { id: service.id, success: true };
        } catch (error) {
          console.error(`Error checking health for service ${service.name}:`, error);
          return { id: service.id, success: false, error: error.message };
        }
      })
    );

    // Get updated services
    const updatedResult = await query(
      `SELECT * FROM services ORDER BY category, name`
    );

    res.json({
      success: true,
      services: updatedResult.rows.map(formatService),
      healthChecks,
    });
  } catch (error) {
    console.error('Error refreshing all services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refresh all services',
    });
  }
}

// Helper functions

/**
 * Check health of a service
 */
async function checkServiceHealth(service) {
  const startTime = Date.now();
  let status = 'unknown';
  let version = null;
  let uptime = null;
  let error = null;

  // Skip health check for services without health endpoints
  if (!service.health_endpoint || service.protocol === 'tcp') {
    return {
      status: 'unknown',
      responseTime: null,
      version: null,
      uptime: null,
      error: 'No HTTP health endpoint configured',
    };
  }

  try {
    const healthUrl = `${service.protocol}://${service.url}:${service.port}${service.health_endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(healthUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeout);

    const responseTime = Date.now() - startTime;

    if (response.ok) {
      status = 'healthy';

      // Try to parse response for additional info
      try {
        const data = await response.json();
        version = data.version || null;
        uptime = data.uptime || null;
      } catch {
        // Response might not be JSON, that's okay
      }
    } else if (response.status >= 500) {
      status = 'unhealthy';
      error = `HTTP ${response.status}`;
    } else if (response.status >= 400) {
      status = 'degraded';
      error = `HTTP ${response.status}`;
    }

    return {
      status,
      responseTime,
      version,
      uptime,
      error,
    };
  } catch (err) {
    const responseTime = Date.now() - startTime;

    if (err.name === 'AbortError') {
      return {
        status: 'unhealthy',
        responseTime,
        version: null,
        uptime: null,
        error: 'Request timeout',
      };
    }

    return {
      status: 'unhealthy',
      responseTime,
      version: null,
      uptime: null,
      error: err.message,
    };
  }
}

/**
 * Update service health information
 */
async function updateServiceHealth(serviceId, healthResult) {
  const { status, responseTime, version, uptime, error } = healthResult;

  // Create event record
  const event = {
    timestamp: new Date().toISOString(),
    status,
    responseTime,
    error,
  };

  // Get current recent_events
  const current = await query(
    `SELECT recent_events FROM services WHERE id = $1`,
    [serviceId]
  );

  let recentEvents = [];
  if (current.rows.length > 0 && current.rows[0].recent_events) {
    recentEvents = current.rows[0].recent_events;
  }

  // Add new event and keep only last 10
  recentEvents.unshift(event);
  recentEvents = recentEvents.slice(0, 10);

  // Update service
  await query(
    `UPDATE services
     SET status = $1,
         response_time = $2,
         version = $3,
         uptime = $4,
         last_checked = NOW(),
         recent_events = $5,
         updated_at = NOW()
     WHERE id = $6`,
    [status, responseTime, version, uptime, JSON.stringify(recentEvents), serviceId]
  );
}

/**
 * Format service for JSON response
 */
function formatService(service) {
  return {
    ...service,
    dependencies: service.dependencies || [],
    environment: service.environment || {},
    recentEvents: service.recent_events || [],
  };
}

/**
 * Ensure default services are populated in development
 */
async function ensureDefaultServices() {
  try {
    // Check if we have any services
    const result = await query(`SELECT COUNT(*) as count FROM services`);
    const count = parseInt(result.rows[0].count);

    // Only populate defaults if no services exist
    if (count === 0) {
      console.log('Populating default WaddleBot services...');

      for (const service of DEFAULT_SERVICES) {
        try {
          await query(
            `INSERT INTO services
              (name, description, category, url, port, protocol, health_endpoint, status, dependencies, environment, recent_events, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'unknown', $8, $9, '[]'::jsonb, NOW(), NOW())
             ON CONFLICT (name) DO NOTHING`,
            [
              service.name,
              service.description,
              service.category,
              service.url,
              service.port,
              service.protocol,
              service.healthEndpoint,
              JSON.stringify(service.dependencies),
              JSON.stringify(service.environment)
            ]
          );
        } catch (err) {
          console.error(`Error adding default service ${service.name}:`, err);
        }
      }

      console.log('Default services populated successfully');
    }
  } catch (error) {
    console.error('Error ensuring default services:', error);
    // Don't throw - this is a best-effort operation
  }
}
