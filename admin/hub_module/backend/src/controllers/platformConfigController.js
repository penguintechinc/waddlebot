/**
 * Platform Configuration Controller
 * Manages platform credentials (Discord, Twitch, Slack, YouTube)
 */
import { query } from '../config/database.js';
import crypto from 'crypto';

// Encryption key from environment (use a 32-byte key for AES-256)
const ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY ||
  crypto.scryptSync(process.env.JWT_SECRET || 'default-key', 'salt', 32);
const IV_LENGTH = 16;

/**
 * Encrypt a value
 */
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a value
 */
function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

/**
 * Mask a secret value for display
 */
function maskSecret(value) {
  if (!value) return null;
  if (value.length <= 8) return '********';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/**
 * Platform configuration schema
 */
const PLATFORM_CONFIGS = {
  discord: {
    fields: ['bot_token', 'client_id', 'client_secret', 'webhook_secret'],
    secrets: ['bot_token', 'client_secret', 'webhook_secret'],
    testEndpoint: 'https://discord.com/api/v10/users/@me'
  },
  twitch: {
    fields: ['client_id', 'client_secret', 'webhook_secret'],
    secrets: ['client_secret', 'webhook_secret'],
    testEndpoint: 'https://id.twitch.tv/oauth2/validate'
  },
  slack: {
    fields: ['bot_token', 'client_id', 'client_secret', 'signing_secret'],
    secrets: ['bot_token', 'client_secret', 'signing_secret'],
    testEndpoint: 'https://slack.com/api/auth.test'
  },
  youtube: {
    fields: ['api_key', 'client_id', 'client_secret'],
    secrets: ['api_key', 'client_secret'],
    testEndpoint: 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true'
  },
  kick: {
    fields: ['client_id', 'client_secret', 'webhook_secret'],
    secrets: ['client_secret', 'webhook_secret'],
    testEndpoint: 'https://kick.com/api/v2/channels'
  },
  email: {
    fields: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_from', 'smtp_from_name', 'smtp_secure'],
    secrets: ['smtp_password'],
    testEndpoint: null
  }
};

/**
 * Get all platform configurations (with masked secrets)
 */
export async function getPlatformConfigs(req, res) {
  try {
    // Get configs from database
    const result = await query(
      `SELECT platform, config_key, config_value, is_encrypted, updated_at
       FROM platform_configs
       ORDER BY platform, config_key`
    );

    // Group by platform
    const configs = {};
    for (const platform of Object.keys(PLATFORM_CONFIGS)) {
      configs[platform] = {
        configured: false,
        fields: {}
      };

      // Add field definitions
      for (const field of PLATFORM_CONFIGS[platform].fields) {
        configs[platform].fields[field] = {
          value: null,
          masked: null,
          isSecret: PLATFORM_CONFIGS[platform].secrets.includes(field)
        };
      }
    }

    // Fill in values from database
    for (const row of result.rows) {
      if (configs[row.platform]) {
        let value = row.config_value;

        // Decrypt if encrypted
        if (row.is_encrypted) {
          value = decrypt(value);
        }

        const isSecret = PLATFORM_CONFIGS[row.platform].secrets.includes(row.config_key);

        configs[row.platform].fields[row.config_key] = {
          value: isSecret ? null : value, // Don't send secrets
          masked: isSecret ? maskSecret(value) : null,
          isSecret,
          hasValue: !!value,
          updatedAt: row.updated_at
        };

        configs[row.platform].configured = true;
      }
    }

    // Check environment variable overrides
    for (const platform of Object.keys(configs)) {
      const envPrefix = platform.toUpperCase();
      for (const field of Object.keys(configs[platform].fields)) {
        const envVar = `${envPrefix}_${field.toUpperCase()}`;
        const envValue = process.env[envVar];

        if (envValue) {
          const isSecret = configs[platform].fields[field].isSecret;
          configs[platform].fields[field] = {
            value: isSecret ? null : envValue,
            masked: isSecret ? maskSecret(envValue) : null,
            isSecret,
            hasValue: true,
            source: 'environment'
          };
          configs[platform].configured = true;
        }
      }
    }

    res.json({
      success: true,
      configs
    });
  } catch (error) {
    console.error('Error getting platform configs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get platform configurations'
    });
  }
}

/**
 * Update platform configuration
 */
export async function updatePlatformConfig(req, res) {
  const { platform } = req.params;
  const config = req.body;

  if (!PLATFORM_CONFIGS[platform]) {
    return res.status(400).json({
      success: false,
      message: `Invalid platform: ${platform}`
    });
  }

  try {
    const platformConfig = PLATFORM_CONFIGS[platform];

    for (const [key, value] of Object.entries(config)) {
      if (!platformConfig.fields.includes(key)) {
        continue; // Skip unknown fields
      }

      // Skip null/undefined values (don't overwrite with empty)
      if (value === null || value === undefined) {
        continue;
      }

      const isSecret = platformConfig.secrets.includes(key);
      const storedValue = isSecret ? encrypt(value) : value;

      // Upsert the config value
      await query(
        `INSERT INTO platform_configs (platform, config_key, config_value, is_encrypted, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, NOW(), $5)
         ON CONFLICT (platform, config_key)
         DO UPDATE SET config_value = $3, is_encrypted = $4, updated_at = NOW(), updated_by = $5`,
        [platform, key, storedValue, isSecret, req.user?.id || null]
      );
    }

    // Log the update
    console.log(`Platform config updated: ${platform} by user ${req.user?.username}`);

    res.json({
      success: true,
      message: `${platform} configuration updated`
    });
  } catch (error) {
    console.error('Error updating platform config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update platform configuration'
    });
  }
}

/**
 * Test platform connection
 */
export async function testPlatformConnection(req, res) {
  const { platform } = req.params;

  if (!PLATFORM_CONFIGS[platform]) {
    return res.status(400).json({
      success: false,
      message: `Invalid platform: ${platform}`
    });
  }

  try {
    // Get credentials (from DB or env)
    const credentials = await getCredentials(platform);

    if (!credentials) {
      return res.status(400).json({
        success: false,
        message: `No credentials configured for ${platform}`
      });
    }

    // Test based on platform
    let testResult;
    switch (platform) {
      case 'discord':
        testResult = await testDiscordConnection(credentials);
        break;
      case 'twitch':
        testResult = await testTwitchConnection(credentials);
        break;
      case 'slack':
        testResult = await testSlackConnection(credentials);
        break;
      case 'youtube':
        testResult = await testYouTubeConnection(credentials);
        break;
      case 'kick':
        testResult = await testKickConnection(credentials);
        break;
      case 'email':
        testResult = await testEmailConnection(credentials);
        break;
      default:
        testResult = { success: false, message: 'Test not implemented' };
    }

    res.json(testResult);
  } catch (error) {
    console.error(`Error testing ${platform} connection:`, error);
    res.status(500).json({
      success: false,
      message: `Connection test failed: ${error.message}`
    });
  }
}

/**
 * Get credentials for a platform (from DB or environment)
 */
async function getCredentials(platform) {
  const result = await query(
    `SELECT config_key, config_value, is_encrypted
     FROM platform_configs
     WHERE platform = $1`,
    [platform]
  );

  const credentials = {};

  // First, get from database
  for (const row of result.rows) {
    let value = row.config_value;
    if (row.is_encrypted) {
      value = decrypt(value);
    }
    credentials[row.config_key] = value;
  }

  // Then, override with environment variables
  const envPrefix = platform.toUpperCase();
  for (const field of PLATFORM_CONFIGS[platform].fields) {
    const envVar = `${envPrefix}_${field.toUpperCase()}`;
    if (process.env[envVar]) {
      credentials[field] = process.env[envVar];
    }
  }

  // Check if we have minimum required credentials
  const hasCredentials = Object.values(credentials).some(v => v);
  return hasCredentials ? credentials : null;
}

/**
 * Test Discord connection
 */
async function testDiscordConnection(credentials) {
  if (!credentials.bot_token) {
    return { success: false, message: 'Bot token not configured' };
  }

  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { 'Authorization': `Bot ${credentials.bot_token}` }
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: `Connected as ${data.username}#${data.discriminator}`,
        data: { username: data.username, id: data.id }
      };
    } else {
      return { success: false, message: `Discord API error: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: `Connection failed: ${error.message}` };
  }
}

/**
 * Test Twitch connection
 */
async function testTwitchConnection(credentials) {
  if (!credentials.client_id || !credentials.client_secret) {
    return { success: false, message: 'Client ID and secret not configured' };
  }

  try {
    // Get app access token
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        grant_type: 'client_credentials'
      })
    });

    if (tokenResponse.ok) {
      const data = await tokenResponse.json();
      return {
        success: true,
        message: 'Twitch credentials validated',
        data: { expiresIn: data.expires_in }
      };
    } else {
      const error = await tokenResponse.json();
      return { success: false, message: `Twitch API error: ${error.message}` };
    }
  } catch (error) {
    return { success: false, message: `Connection failed: ${error.message}` };
  }
}

/**
 * Test Slack connection
 */
async function testSlackConnection(credentials) {
  if (!credentials.bot_token) {
    return { success: false, message: 'Bot token not configured' };
  }

  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credentials.bot_token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    if (data.ok) {
      return {
        success: true,
        message: `Connected to ${data.team} as ${data.user}`,
        data: { team: data.team, user: data.user, teamId: data.team_id }
      };
    } else {
      return { success: false, message: `Slack API error: ${data.error}` };
    }
  } catch (error) {
    return { success: false, message: `Connection failed: ${error.message}` };
  }
}

/**
 * Test YouTube connection
 */
async function testYouTubeConnection(credentials) {
  if (!credentials.api_key) {
    return { success: false, message: 'API key not configured' };
  }

  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${credentials.api_key}`
    );

    if (response.ok) {
      return {
        success: true,
        message: 'YouTube API key validated'
      };
    } else {
      const error = await response.json();
      return {
        success: false,
        message: `YouTube API error: ${error.error?.message || response.status}`
      };
    }
  } catch (error) {
    return { success: false, message: `Connection failed: ${error.message}` };
  }
}

/**
 * Test KICK connection
 */
async function testKickConnection(credentials) {
  if (!credentials.client_id || !credentials.client_secret) {
    return { success: false, message: 'Client ID and secret not configured' };
  }

  try {
    // Get app access token from KICK
    const tokenResponse = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        grant_type: 'client_credentials'
      })
    });

    if (tokenResponse.ok) {
      const data = await tokenResponse.json();
      return {
        success: true,
        message: 'KICK credentials validated',
        data: { expiresIn: data.expires_in }
      };
    } else {
      const error = await tokenResponse.json().catch(() => ({}));
      return { success: false, message: `KICK API error: ${error.message || tokenResponse.status}` };
    }
  } catch (error) {
    return { success: false, message: `Connection failed: ${error.message}` };
  }
}

/**
 * Test email (SMTP) connection
 */
async function testEmailConnection(credentials) {
  if (!credentials.smtp_host || !credentials.smtp_port) {
    return { success: false, message: 'SMTP host and port not configured' };
  }

  try {
    // Dynamic import nodemailer
    const nodemailer = await import('nodemailer');

    const transportConfig = {
      host: credentials.smtp_host,
      port: parseInt(credentials.smtp_port, 10),
      secure: credentials.smtp_secure === 'true',
    };

    if (credentials.smtp_user && credentials.smtp_password) {
      transportConfig.auth = {
        user: credentials.smtp_user,
        pass: credentials.smtp_password
      };
    }

    const transporter = nodemailer.default.createTransport(transportConfig);

    // Verify connection
    await transporter.verify();

    // Update email_configured setting
    await query(
      `INSERT INTO hub_settings (setting_key, setting_value, updated_at)
       VALUES ('email_configured', 'true', NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = 'true', updated_at = NOW()`
    );

    return {
      success: true,
      message: `SMTP connection verified: ${credentials.smtp_host}:${credentials.smtp_port}`
    };
  } catch (error) {
    return { success: false, message: `SMTP connection failed: ${error.message}` };
  }
}

/**
 * Get hub settings
 */
export async function getHubSettings(req, res) {
  try {
    const result = await query(
      `SELECT setting_key, setting_value, updated_at FROM hub_settings`
    );

    const settings = {};
    for (const row of result.rows) {
      settings[row.setting_key] = {
        value: row.setting_value,
        updatedAt: row.updated_at
      };
    }

    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error getting hub settings:', error);
    res.status(500).json({ success: false, message: 'Failed to get hub settings' });
  }
}

/**
 * Update hub settings
 */
export async function updateHubSettings(req, res) {
  const { settings } = req.body;

  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ success: false, message: 'Invalid settings object' });
  }

  try {
    for (const [key, value] of Object.entries(settings)) {
      await query(
        `INSERT INTO hub_settings (setting_key, setting_value, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (setting_key)
         DO UPDATE SET setting_value = $2, updated_at = NOW(), updated_by = $3`,
        [key, String(value), req.user?.id || null]
      );
    }

    console.log(`Hub settings updated by user ${req.user?.username}`);

    res.json({ success: true, message: 'Settings updated' });
  } catch (error) {
    console.error('Error updating hub settings:', error);
    res.status(500).json({ success: false, message: 'Failed to update hub settings' });
  }
}
