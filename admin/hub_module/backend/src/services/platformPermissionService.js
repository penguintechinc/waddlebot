/**
 * Platform Permission Service
 * Verifies user has admin/owner permissions on platform servers
 */
import axios from 'axios';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * Get user's platform identity with access token
 */
async function getUserPlatformIdentity(userId, platform) {
  const result = await query(
    `SELECT platform_user_id, platform_username, access_token, refresh_token, token_expires_at
     FROM hub_user_identities
     WHERE user_id = $1 AND platform = $2`,
    [userId, platform]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Get platform config (client ID, etc.)
 */
async function getPlatformConfig(platform) {
  const result = await query(
    `SELECT config_key, config_value FROM platform_configs WHERE platform = $1`,
    [platform]
  );

  const config = {};
  for (const row of result.rows) {
    config[row.config_key] = row.config_value;
  }
  return config;
}

/**
 * Verify Discord server admin status
 * Checks if user has ADMINISTRATOR or MANAGE_GUILD permission
 */
export async function verifyDiscordServerAdmin(userId, guildId) {
  try {
    const identity = await getUserPlatformIdentity(userId, 'discord');
    if (!identity || !identity.access_token) {
      return { verified: false, error: 'No Discord account linked or missing access token' };
    }

    // Get user's guilds from Discord API
    const response = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${identity.access_token}` },
    });

    // Find the specific guild
    const guild = response.data.find((g) => g.id === guildId);
    if (!guild) {
      return { verified: false, error: 'User is not a member of this Discord server' };
    }

    // Check permissions (ADMINISTRATOR = 0x8, MANAGE_GUILD = 0x20)
    const permissions = BigInt(guild.permissions || 0);
    const ADMINISTRATOR = 0x8n;
    const MANAGE_GUILD = 0x20n;

    const isAdmin = (permissions & ADMINISTRATOR) === ADMINISTRATOR;
    const canManageGuild = (permissions & MANAGE_GUILD) === MANAGE_GUILD;

    if (isAdmin || canManageGuild || guild.owner) {
      return {
        verified: true,
        serverName: guild.name,
        isOwner: guild.owner || false,
        platformUserId: identity.platform_user_id,
      };
    }

    return { verified: false, error: 'User does not have admin permissions on this server' };
  } catch (err) {
    logger.error('Discord permission check failed', { error: err.message, userId, guildId });
    if (err.response?.status === 401) {
      return { verified: false, error: 'Discord access token expired. Please re-link your Discord account.' };
    }
    return { verified: false, error: 'Failed to verify Discord permissions' };
  }
}

/**
 * Verify Twitch channel owner status
 * Checks if user is the broadcaster of the channel
 */
export async function verifyTwitchChannelOwner(userId, channelId) {
  try {
    const identity = await getUserPlatformIdentity(userId, 'twitch');
    if (!identity) {
      return { verified: false, error: 'No Twitch account linked' };
    }

    // For Twitch, the channel owner is the user whose ID matches the channel ID
    // channelId should be the broadcaster's user ID
    if (identity.platform_user_id === channelId) {
      return {
        verified: true,
        serverName: identity.platform_username,
        isOwner: true,
        platformUserId: identity.platform_user_id,
      };
    }

    // If we have an access token, we can also check via API
    if (identity.access_token) {
      const platformConfig = await getPlatformConfig('twitch');
      const clientId = platformConfig.client_id;

      if (clientId) {
        try {
          const response = await axios.get(
            `https://api.twitch.tv/helix/channels?broadcaster_id=${channelId}`,
            {
              headers: {
                Authorization: `Bearer ${identity.access_token}`,
                'Client-Id': clientId,
              },
            }
          );

          if (response.data.data && response.data.data.length > 0) {
            const channel = response.data.data[0];
            // Check if user is the broadcaster
            if (channel.broadcaster_id === identity.platform_user_id) {
              return {
                verified: true,
                serverName: channel.broadcaster_name,
                isOwner: true,
                platformUserId: identity.platform_user_id,
              };
            }
          }
        } catch (apiErr) {
          logger.warn('Twitch API check failed, falling back to ID comparison', { error: apiErr.message });
        }
      }
    }

    return { verified: false, error: 'User is not the owner of this Twitch channel' };
  } catch (err) {
    logger.error('Twitch permission check failed', { error: err.message, userId, channelId });
    return { verified: false, error: 'Failed to verify Twitch channel ownership' };
  }
}

/**
 * Verify Slack workspace admin status
 */
export async function verifySlackWorkspaceAdmin(userId, workspaceId) {
  try {
    const identity = await getUserPlatformIdentity(userId, 'slack');
    if (!identity || !identity.access_token) {
      return { verified: false, error: 'No Slack account linked or missing access token' };
    }

    // Use Slack API to check user's admin status
    const response = await axios.get('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${identity.access_token}` },
    });

    if (!response.data.ok) {
      return { verified: false, error: 'Failed to verify Slack credentials' };
    }

    // Check if the workspace matches
    if (response.data.team_id !== workspaceId) {
      return { verified: false, error: 'User is not in this Slack workspace' };
    }

    // Get user info to check admin status
    const userResponse = await axios.get(
      `https://slack.com/api/users.info?user=${identity.platform_user_id}`,
      {
        headers: { Authorization: `Bearer ${identity.access_token}` },
      }
    );

    if (!userResponse.data.ok) {
      return { verified: false, error: 'Failed to get Slack user info' };
    }

    const user = userResponse.data.user;
    if (user.is_admin || user.is_owner || user.is_primary_owner) {
      return {
        verified: true,
        serverName: response.data.team,
        isOwner: user.is_owner || user.is_primary_owner || false,
        platformUserId: identity.platform_user_id,
      };
    }

    return { verified: false, error: 'User does not have admin permissions in this Slack workspace' };
  } catch (err) {
    logger.error('Slack permission check failed', { error: err.message, userId, workspaceId });
    return { verified: false, error: 'Failed to verify Slack permissions' };
  }
}

/**
 * Verify YouTube channel owner status
 */
export async function verifyYouTubeChannelOwner(userId, channelId) {
  try {
    const identity = await getUserPlatformIdentity(userId, 'youtube');
    if (!identity) {
      return { verified: false, error: 'No YouTube account linked' };
    }

    // For YouTube, check if the linked channel ID matches
    if (identity.platform_user_id === channelId) {
      return {
        verified: true,
        serverName: identity.platform_username,
        isOwner: true,
        platformUserId: identity.platform_user_id,
      };
    }

    // If we have an access token, verify via API
    if (identity.access_token) {
      try {
        const response = await axios.get(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          {
            headers: { Authorization: `Bearer ${identity.access_token}` },
          }
        );

        if (response.data.items && response.data.items.length > 0) {
          const channel = response.data.items.find((c) => c.id === channelId);
          if (channel) {
            return {
              verified: true,
              serverName: channel.snippet.title,
              isOwner: true,
              platformUserId: channel.id,
            };
          }
        }
      } catch (apiErr) {
        logger.warn('YouTube API check failed', { error: apiErr.message });
      }
    }

    return { verified: false, error: 'User is not the owner of this YouTube channel' };
  } catch (err) {
    logger.error('YouTube permission check failed', { error: err.message, userId, channelId });
    return { verified: false, error: 'Failed to verify YouTube channel ownership' };
  }
}

/**
 * Verify platform admin status (dispatcher function)
 */
export async function verifyPlatformAdmin(userId, platform, serverId) {
  switch (platform) {
    case 'discord':
      return verifyDiscordServerAdmin(userId, serverId);
    case 'twitch':
      return verifyTwitchChannelOwner(userId, serverId);
    case 'slack':
      return verifySlackWorkspaceAdmin(userId, serverId);
    case 'youtube':
      return verifyYouTubeChannelOwner(userId, serverId);
    default:
      return { verified: false, error: `Unsupported platform: ${platform}` };
  }
}

/**
 * Check if user is a community admin
 */
export async function isUserCommunityAdmin(userId, communityId) {
  const result = await query(
    `SELECT role FROM community_members
     WHERE community_id = $1 AND user_id = $2 AND is_active = true`,
    [communityId, userId]
  );

  if (result.rows.length === 0) {
    return false;
  }

  const adminRoles = ['community-owner', 'community-admin'];
  return adminRoles.includes(result.rows[0].role);
}
