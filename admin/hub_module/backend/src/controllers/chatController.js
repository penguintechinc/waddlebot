/**
 * Chat Controller
 * REST API endpoints for chat history and channels
 */
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * Get chat message history for a community
 * GET /api/v1/communities/:communityId/chat/history
 */
export async function getChatHistory(req, res, next) {
  try {
    const { communityId } = req.params;
    const { channelName, limit = 50, before } = req.query;

    let queryText = `
      SELECT id, community_id, channel_name, sender_hub_user_id,
             sender_platform, sender_username, sender_avatar_url,
             message_content, message_type, created_at
      FROM hub_chat_messages
      WHERE community_id = $1
    `;
    const params = [communityId];

    // Filter by channel if provided
    if (channelName) {
      queryText += ' AND channel_name = $2';
      params.push(channelName);
    }

    // Pagination with before timestamp
    if (before) {
      queryText += ` AND created_at < $${params.length + 1}`;
      params.push(before);
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(parseInt(limit), 100)); // Max 100 messages

    const result = await query(queryText, params);

    // Format messages
    const messages = result.rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      channelName: row.channel_name,
      senderId: row.sender_hub_user_id,
      senderPlatform: row.sender_platform,
      senderUsername: row.sender_username,
      senderAvatarUrl: row.sender_avatar_url,
      content: row.message_content,
      type: row.message_type,
      createdAt: row.created_at,
    })).reverse(); // Reverse to show oldest first

    logger.audit('Chat history fetched via REST', {
      userId: req.user?.id,
      communityId,
      channelName,
      messageCount: messages.length,
    });

    res.json({
      success: true,
      data: {
        messages,
        hasMore: result.rows.length === Math.min(parseInt(limit), 100),
      },
    });
  } catch (err) {
    logger.error('Error fetching chat history', { error: err.message });
    next(err);
  }
}

/**
 * Get available chat channels for a community
 * GET /api/v1/communities/:communityId/chat/channels
 */
export async function getChatChannels(req, res, next) {
  try {
    const { communityId } = req.params;

    // Get distinct channels with message count and last message
    const result = await query(
      `SELECT
         channel_name,
         COUNT(*) as message_count,
         MAX(created_at) as last_message_at
       FROM hub_chat_messages
       WHERE community_id = $1
       GROUP BY channel_name
       ORDER BY last_message_at DESC`,
      [communityId]
    );

    const channels = result.rows.map((row) => ({
      name: row.channel_name || 'general',
      messageCount: parseInt(row.message_count),
      lastMessageAt: row.last_message_at,
    }));

    // Always include 'general' channel if not present
    if (!channels.find((ch) => ch.name === 'general')) {
      channels.unshift({
        name: 'general',
        messageCount: 0,
        lastMessageAt: null,
      });
    }

    logger.audit('Chat channels fetched', {
      userId: req.user?.id,
      communityId,
      channelCount: channels.length,
    });

    res.json({
      success: true,
      data: { channels },
    });
  } catch (err) {
    logger.error('Error fetching chat channels', { error: err.message });
    next(err);
  }
}
