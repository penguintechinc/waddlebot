# Multi-stage Dockerfile for WaddleBot Hub Module
# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./

# Install frontend dependencies
RUN npm install

# Copy frontend source
COPY frontend/ ./

# Build frontend
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

WORKDIR /app

# Install dumb-init and build tools for native modules (bcrypt)
RUN apk add --no-cache dumb-init python3 make g++

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy backend package files
COPY backend/package*.json ./

# Install production dependencies only
RUN npm install --only=production

# Remove build tools to reduce image size
RUN apk del python3 make g++

# Copy backend source
COPY --chown=nodejs:nodejs backend/src ./src

# Copy built frontend from build stage
COPY --chown=nodejs:nodejs --from=frontend-build /app/frontend/dist ./public

# Create log directory and fix ownership
RUN mkdir -p /var/log/waddlebotlog && chown -R nodejs:nodejs /var/log/waddlebotlog /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8060

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 8060

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8060/health || exit 1

# Start with dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
