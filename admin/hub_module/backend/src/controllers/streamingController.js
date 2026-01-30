/**
 * Streaming Management Controller
 * Manages video proxy streaming configuration and destinations
 */
import axios from 'axios';
import { errors } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const VIDEO_PROXY_API_URL = process.env.VIDEO_PROXY_API_URL || 'http://video_proxy_module:8014';

/**
 * Get stream configuration for a community
 */
export async function getStreamConfig(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Call video_proxy_module to get config
    const response = await axios.get(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/config/${communityId}`,
      { timeout: 5000 }
    );

    logger.info('Fetched stream config', {
      communityId,
      userId: req.user.id,
    });

    res.json({ success: true, config: response.data });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.json({ success: true, config: null });
    }
    logger.error('Failed to fetch stream config', {
      error: err.message,
      communityId: req.params.communityId,
    });
    next(errors.serviceError('Failed to fetch stream configuration'));
  }
}

/**
 * Create stream configuration for a community
 */
export async function createStreamConfig(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { rtmpPort, httpPort, enabled } = req.body;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Validate inputs
    if (rtmpPort && (rtmpPort < 1024 || rtmpPort > 65535)) {
      return next(errors.badRequest('Invalid RTMP port'));
    }

    if (httpPort && (httpPort < 1024 || httpPort > 65535)) {
      return next(errors.badRequest('Invalid HTTP port'));
    }

    // Call video_proxy_module to create config
    const response = await axios.post(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/config`,
      {
        communityId,
        rtmpPort,
        httpPort,
        enabled: enabled !== false,
      },
      { timeout: 5000 }
    );

    logger.info('Created stream config', {
      communityId,
      userId: req.user.id,
      rtmpPort,
      httpPort,
    });

    res.status(201).json({ success: true, config: response.data });
  } catch (err) {
    logger.error('Failed to create stream config', {
      error: err.message,
      communityId: req.params.communityId,
    });
    if (err.response?.status === 409) {
      return next(errors.conflict('Stream configuration already exists'));
    }
    next(errors.serviceError('Failed to create stream configuration'));
  }
}

/**
 * Regenerate stream key for a community
 */
export async function regenerateStreamKey(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Call video_proxy_module to regenerate key
    const response = await axios.post(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/config/${communityId}/regenerate-key`,
      {},
      { timeout: 5000 }
    );

    logger.warn('Regenerated stream key', {
      communityId,
      userId: req.user.id,
    });

    res.json({ success: true, streamKey: response.data.streamKey });
  } catch (err) {
    logger.error('Failed to regenerate stream key', {
      error: err.message,
      communityId: req.params.communityId,
    });
    if (err.response?.status === 404) {
      return next(errors.notFound('Stream configuration not found'));
    }
    next(errors.serviceError('Failed to regenerate stream key'));
  }
}

/**
 * Get streaming destinations for a community
 */
export async function getDestinations(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Call video_proxy_module to get destinations
    const response = await axios.get(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/destinations/${communityId}`,
      { timeout: 5000 }
    );

    logger.info('Fetched streaming destinations', {
      communityId,
      userId: req.user.id,
      count: response.data.destinations?.length || 0,
    });

    res.json({ success: true, destinations: response.data.destinations || [] });
  } catch (err) {
    logger.error('Failed to fetch destinations', {
      error: err.message,
      communityId: req.params.communityId,
    });
    next(errors.serviceError('Failed to fetch streaming destinations'));
  }
}

/**
 * Add streaming destination for a community
 */
export async function addDestination(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const { platform, rtmpUrl, streamKey, enabled, forceCut } = req.body;

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Validate required fields
    if (!platform || !rtmpUrl || !streamKey) {
      return next(errors.badRequest('Missing required fields: platform, rtmpUrl, streamKey'));
    }

    // Validate platform
    const validPlatforms = ['twitch', 'youtube', 'facebook', 'custom'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return next(errors.badRequest('Invalid platform'));
    }

    // Validate RTMP URL format
    if (!rtmpUrl.startsWith('rtmp://') && !rtmpUrl.startsWith('rtmps://')) {
      return next(errors.badRequest('Invalid RTMP URL format'));
    }

    // Call video_proxy_module to add destination
    const response = await axios.post(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/destinations`,
      {
        communityId,
        platform: platform.toLowerCase(),
        rtmpUrl,
        streamKey,
        enabled: enabled !== false,
        forceCut: forceCut === true,
      },
      { timeout: 5000 }
    );

    logger.info('Added streaming destination', {
      communityId,
      userId: req.user.id,
      platform: platform.toLowerCase(),
    });

    res.status(201).json({ success: true, destination: response.data.destination });
  } catch (err) {
    logger.error('Failed to add destination', {
      error: err.message,
      communityId: req.params.communityId,
    });
    if (err.response?.status === 404) {
      return next(errors.notFound('Stream configuration not found'));
    }
    next(errors.serviceError('Failed to add streaming destination'));
  }
}

/**
 * Remove streaming destination
 */
export async function removeDestination(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const destinationId = parseInt(req.params.destinationId, 10);

    if (isNaN(communityId) || isNaN(destinationId)) {
      return next(errors.badRequest('Invalid community ID or destination ID'));
    }

    // Call video_proxy_module to remove destination
    await axios.delete(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/destinations/${destinationId}`,
      {
        params: { communityId },
        timeout: 5000,
      }
    );

    logger.info('Removed streaming destination', {
      communityId,
      destinationId,
      userId: req.user.id,
    });

    res.json({ success: true, message: 'Destination removed successfully' });
  } catch (err) {
    logger.error('Failed to remove destination', {
      error: err.message,
      communityId: req.params.communityId,
      destinationId: req.params.destinationId,
    });
    if (err.response?.status === 404) {
      return next(errors.notFound('Destination not found'));
    }
    next(errors.serviceError('Failed to remove streaming destination'));
  }
}

/**
 * Toggle force cut for a destination
 */
export async function toggleForceCut(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);
    const destinationId = parseInt(req.params.destinationId, 10);
    const { forceCut } = req.body;

    if (isNaN(communityId) || isNaN(destinationId)) {
      return next(errors.badRequest('Invalid community ID or destination ID'));
    }

    if (typeof forceCut !== 'boolean') {
      return next(errors.badRequest('forceCut must be a boolean'));
    }

    // Call video_proxy_module to toggle force cut
    const response = await axios.put(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/destinations/${destinationId}/force-cut`,
      {
        communityId,
        forceCut,
      },
      { timeout: 5000 }
    );

    logger.info('Toggled force cut for destination', {
      communityId,
      destinationId,
      forceCut,
      userId: req.user.id,
    });

    res.json({ success: true, destination: response.data.destination });
  } catch (err) {
    logger.error('Failed to toggle force cut', {
      error: err.message,
      communityId: req.params.communityId,
      destinationId: req.params.destinationId,
    });
    if (err.response?.status === 404) {
      return next(errors.notFound('Destination not found'));
    }
    next(errors.serviceError('Failed to toggle force cut'));
  }
}

/**
 * Get streaming status for a community
 */
export async function getStreamStatus(req, res, next) {
  try {
    const communityId = parseInt(req.params.communityId, 10);

    if (isNaN(communityId)) {
      return next(errors.badRequest('Invalid community ID'));
    }

    // Call video_proxy_module to get status
    const response = await axios.get(
      `${VIDEO_PROXY_API_URL}/api/v1/streaming/status/${communityId}`,
      { timeout: 5000 }
    );

    logger.info('Fetched streaming status', {
      communityId,
      userId: req.user.id,
    });

    res.json({ success: true, status: response.data });
  } catch (err) {
    logger.error('Failed to fetch streaming status', {
      error: err.message,
      communityId: req.params.communityId,
    });
    if (err.response?.status === 404) {
      return res.json({ success: true, status: { active: false, destinations: [] } });
    }
    next(errors.serviceError('Failed to fetch streaming status'));
  }
}
