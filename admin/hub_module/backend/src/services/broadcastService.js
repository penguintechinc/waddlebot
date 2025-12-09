/**
 * Broadcast Service
 * Handles broadcasting announcements to connected platforms
 * (Discord, Slack, Twitch, YouTube)
 */
import axios from 'axios';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

// Color mapping for announcement types
const TYPE_COLORS = {
  general: {
    discord: 0x3498db,    // Blue
    twitch: 'blue',
  },
  important: {
    discord: 0xe74c3c,    // Red
    twitch: 'orange',
  },
  event: {
    discord: 0x9b59b6,    // Purple
    twitch: 'purple',
  },
  update: {
    discord: 0x2ecc71,    // Green
    twitch: 'green',
  },
};

class BroadcastService {
  /**
   * Get action module endpoint URL with fallback
   */
  getEndpointUrl(platform) {
    const endpoints = {
      discord: process.env.DISCORD_ACTION_URL || 'http://localhost:8070',
      slack: process.env.SLACK_ACTION_URL || 'http://localhost:8071',
      twitch: process.env.TWITCH_ACTION_URL || 'http://localhost:8072',
      youtube: process.env.YOUTUBE_ACTION_URL || 'http://localhost:8073',
    };

    return endpoints[platform] || null;
  }

  /**
   * Broadcast announcement to all configured platforms for a community
   * @param {number} communityId - Community identifier
   * @param {object} announcement - Announcement data with title, content, type
   * @param {array} targetPlatforms - Platforms to target ['discord', 'slack', etc.]
   * @returns {Promise<object>} Summary of broadcast results
   */
  async broadcastToAllPlatforms(communityId, announcement, targetPlatforms) {
    logger.audit('Broadcasting announcement to platforms', {
      community: communityId,
      platforms: targetPlatforms,
      announcementId: announcement.id,
    });

    try {
      // Get all linked servers for the community
      const serversResult = await query(
        `SELECT id, platform, server_id, config
         FROM community_servers
         WHERE community_id = $1 AND is_active = true`,
        [communityId]
      );

      const servers = serversResult.rows.filter((server) =>
        targetPlatforms.includes(server.platform)
      );

      if (servers.length === 0) {
        logger.warn('No active servers found for broadcast', {
          community: communityId,
          platforms: targetPlatforms,
        });
        return {
          success: false,
          error: 'No active servers found for target platforms',
          results: [],
        };
      }

      // Broadcast to all servers in parallel
      const broadcastPromises = servers.map((server) =>
        this.broadcastToServer(communityId, announcement, server)
      );

      const results = await Promise.allSettled(broadcastPromises);

      // Process results
      const successCount = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
      const failureCount = results.length - successCount;

      logger.info('Broadcast campaign completed', {
        community: communityId,
        announcementId: announcement.id,
        totalServers: servers.length,
        successful: successCount,
        failed: failureCount,
      });

      return {
        success: failureCount === 0,
        summary: {
          totalServers: servers.length,
          successful: successCount,
          failed: failureCount,
        },
        results: results.map((r, idx) => ({
          server: servers[idx],
          result: r.status === 'fulfilled' ? r.value : { success: false, error: r.reason.message },
        })),
      };
    } catch (err) {
      logger.error('Broadcast to all platforms failed', {
        error: err.message,
        community: communityId,
      });
      throw err;
    }
  }

  /**
   * Broadcast announcement to a specific server
   * @private
   */
  async broadcastToServer(communityId, announcement, server) {
    try {
      // Find announcement channel
      const channelId = await this.findAnnouncementChannel(server.platform, server.server_id);

      if (!channelId) {
        return {
          success: false,
          error: 'No announcement channel found',
        };
      }

      // Broadcast to platform
      const result = await this.broadcastToPlatform(
        server.platform,
        server.server_id,
        channelId,
        announcement
      );

      // Save broadcast result
      await this.saveBroadcastResult(announcement.id, server, channelId, result);

      return result;
    } catch (err) {
      logger.error('Server broadcast failed', {
        error: err.message,
        community: communityId,
        server: server.id,
        platform: server.platform,
      });
      throw err;
    }
  }

  /**
   * Broadcast to a specific platform endpoint
   * @param {string} platform - Platform name (discord, slack, twitch, youtube)
   * @param {string} serverId - Server/workspace ID on platform
   * @param {string} channelId - Channel ID on platform
   * @param {object} announcement - Announcement data
   * @returns {Promise<object>} Result with success, platform_message_id, error
   */
  async broadcastToPlatform(platform, serverId, channelId, announcement) {
    try {
      const endpoint = this.getEndpointUrl(platform);
      if (!endpoint) {
        return {
          success: false,
          error: `Unknown platform: ${platform}`,
        };
      }

      // Format announcement for platform
      const formattedMessage = this.formatAnnouncementForPlatform(announcement, platform);

      // Determine endpoint path based on platform
      let path = '/api/v1/send-message';
      if (platform === 'twitch') {
        path = '/api/v1/send-announcement';
      }

      // Send request to action module
      const response = await axios.post(`${endpoint}${path}`, {
        server_id: serverId,
        channel_id: channelId,
        message: formattedMessage,
        platform,
      }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      logger.audit('Platform broadcast successful', {
        platform,
        server: serverId,
        channel: channelId,
      });

      return {
        success: true,
        platform_message_id: response.data.message_id || response.data.id,
      };
    } catch (err) {
      logger.error('Platform broadcast failed', {
        error: err.message,
        platform,
        server: serverId,
        channel: channelId,
      });

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Find the announcement channel for a server
   * @param {string} platform - Platform name
   * @param {string} serverId - Server ID on platform
   * @returns {Promise<string|null>} Channel ID or null
   */
  async findAnnouncementChannel(platform, serverId) {
    try {
      // Get server configuration
      const serverResult = await query(
        `SELECT config FROM community_servers
         WHERE platform = $1 AND server_id = $2 LIMIT 1`,
        [platform, serverId]
      );

      if (serverResult.rows.length > 0) {
        const config = serverResult.rows[0].config || {};
        if (config.announcement_channel_id) {
          return config.announcement_channel_id;
        }
      }

      // Fallback: look for channel with 'announcement' in name
      // This would typically be done through action module API
      // For now, return null and let caller handle default
      logger.debug('No announcement channel configured', {
        platform,
        server: serverId,
      });

      // Return common defaults per platform
      const defaults = {
        discord: null, // Requires explicit configuration
        slack: null,   // Requires explicit configuration
        twitch: null,  // Twitch uses single channel
        youtube: null, // YouTube uses single channel
      };

      return defaults[platform] || null;
    } catch (err) {
      logger.error('Failed to find announcement channel', {
        error: err.message,
        platform,
        server: serverId,
      });
      return null;
    }
  }

  /**
   * Format announcement for platform-specific message format
   * @param {object} announcement - Announcement with title, content, announcement_type
   * @param {string} platform - Platform name
   * @returns {object} Platform-specific formatted message
   */
  formatAnnouncementForPlatform(announcement, platform) {
    const type = announcement.announcement_type || 'general';
    const colors = TYPE_COLORS[type] || TYPE_COLORS.general;

    switch (platform) {
      case 'discord':
        return {
          embed: {
            title: announcement.title,
            description: announcement.content,
            color: colors.discord,
            timestamp: announcement.created_at || new Date().toISOString(),
          },
        };

      case 'slack':
        return {
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `📢 ${announcement.title}`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: announcement.content,
              },
            },
          ],
        };

      case 'twitch':
        return {
          message: `📢 ${announcement.title}\n\n${announcement.content}`,
          color: colors.twitch,
        };

      case 'youtube':
        return {
          message: `📢 ${announcement.title}\n\n${announcement.content}`,
          color: colors.twitch,
        };

      default:
        return {
          message: `${announcement.title}\n${announcement.content}`,
        };
    }
  }

  /**
   * Save broadcast attempt to database
   * @param {number} announcementId - Announcement ID
   * @param {object} server - Server info from community_servers
   * @param {string} channelId - Channel ID message was sent to
   * @param {object} result - Result from broadcastToPlatform
   */
  async saveBroadcastResult(announcementId, server, channelId, result) {
    try {
      await query(
        `INSERT INTO announcement_broadcasts
         (announcement_id, community_server_id, platform, channel_id, status, platform_message_id, error_message, broadcasted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          announcementId,
          server.id,
          server.platform,
          channelId,
          result.success ? 'success' : 'failed',
          result.platform_message_id || null,
          result.error || null,
        ]
      );

      logger.audit('Broadcast result saved', {
        announcementId,
        server: server.id,
        platform: server.platform,
        status: result.success ? 'success' : 'failed',
      });
    } catch (err) {
      logger.error('Failed to save broadcast result', {
        error: err.message,
        announcementId,
        server: server.id,
      });
      // Don't throw - broadcasting already completed, just log the failure
    }
  }
}

export default new BroadcastService();
