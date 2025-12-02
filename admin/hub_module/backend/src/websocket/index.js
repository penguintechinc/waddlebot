/**
 * WebSocket Setup
 * Socket.io configuration for real-time chat
 */
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { handleChatEvents } from './chatHandler.js';

/**
 * Setup Socket.io with Express HTTP server
 */
export function setupWebSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: config.cors.origin,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Authentication middleware for socket connections
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, config.jwt.secret);

      if (!decoded || !decoded.userId) {
        return next(new Error('Invalid token'));
      }

      // Attach user info to socket
      socket.userId = decoded.userId;
      socket.platform = decoded.platform;
      socket.platformUserId = decoded.platformUserId;
      socket.username = decoded.username;
      socket.avatarUrl = decoded.avatarUrl;

      logger.auth('WebSocket authentication successful', {
        userId: socket.userId,
        username: socket.username,
        socketId: socket.id,
      });

      next();
    } catch (err) {
      logger.error('WebSocket authentication failed', {
        error: err.message,
        socketId: socket.id,
      });
      next(new Error('Authentication failed'));
    }
  });

  // Connection handling
  io.on('connection', (socket) => {
    logger.system('WebSocket client connected', {
      socketId: socket.id,
      userId: socket.userId,
      username: socket.username,
    });

    // Setup chat event handlers
    handleChatEvents(io, socket);

    // Disconnection handling
    socket.on('disconnect', (reason) => {
      logger.system('WebSocket client disconnected', {
        socketId: socket.id,
        userId: socket.userId,
        username: socket.username,
        reason,
      });
    });

    // Error handling
    socket.on('error', (error) => {
      logger.error('WebSocket error', {
        socketId: socket.id,
        userId: socket.userId,
        error: error.message,
      });
    });
  });

  logger.system('WebSocket server initialized');

  return io;
}
