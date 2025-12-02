# WaddleBot Module Details - Core Components & Trigger Modules

This document provides comprehensive technical details for WaddleBot core components and trigger modules. For action/interactive modules, see [module-details-action.md](module-details-action.md). For high-level architecture, see [CLAUDE.md](../CLAUDE.md).

## Module Architecture Overview

WaddleBot follows a modular, microservices architecture with three primary module categories:

- **Core Components**: Central services handling routing, authentication, identity, and browser source management
- **Trigger Modules (Receivers)**: Platform-specific modules that receive webhooks and events from Twitch, Discord, and Slack
- **Action Modules (Interactive)**: Response modules that process commands and return chat messages, media displays, or data

All modules communicate through the Router Module, which handles command routing, rate limiting, and execution coordination. Modules are deployed as individual Docker containers with Flask/Quart frameworks on Python 3.13.

---

## Core Components

### Router Module (`processing/router_module_flask/`)

**Purpose**: High-performance command router and event processor - the central brain of WaddleBot

**Key Features**:
- **High-Performance Processing**: Multi-threaded command processing with ThreadPoolExecutor
- **Command Routing**: Parses `!` (local container) and `#` (community Lambda/OpenWhisk) prefixed commands
- **Database Optimization**: Uses read replicas for command lookups, primary for writes
- **Caching Layer**: In-memory caching with TTL for commands and entity permissions
- **Rate Limiting**: Sliding window rate limiter with per-user/command/entity tracking
- **Execution Engine**: Routes to local containers, AWS Lambda, OpenWhisk, or webhook endpoints
- **Metrics & Monitoring**: Real-time performance metrics and health monitoring
- **Batch Processing**: Supports up to 100 concurrent event processing

**Technical Details**:
- Multi-threaded execution with configurable worker pools
- Session management via Redis with TTL
- String matching system for content moderation and auto-responses
- Support for sequential and parallel module execution
- Comprehensive execution audit logging

---

### Marketplace Module (`admin/marketplace_module_flask/`)

**Purpose**: Community module marketplace for browsing, installing, and managing modules

**Key Features**:
- **Module Management**: Browse, search, install, and manage community modules
- **Permission System**: Entity-based permissions for module installation/management
- **Version Control**: Multiple module versions with upgrade/downgrade support
- **Review System**: User reviews and ratings for modules
- **Router Integration**: Automatic command registration/removal with router
- **Usage Analytics**: Track module usage and performance statistics
- **Category System**: Hierarchical module categorization

**Technical Details**:
- Paid subscription system with payment blocking for expired subscriptions
- Automatic synchronization with router for command registration
- Module discovery with search and filtering capabilities

---

### Hub Module (`admin/hub_module/`)

**Purpose**: Community management portal with authentication and direct routing (replaces Kong API Gateway)

**Key Features**:
- **Community Management Portal**: Web-based interface for community administrators
- **Direct Routing**: Replaces Kong API Gateway with direct service routing
- **User Authentication**: Flask-Security-Too for user authentication and session management
- **Role-Based Access Control**: User roles for trigger, action, core, admin, and user permissions
- **Rate Limiting**: Per-service and per-role rate limiting with Redis backend
- **Dashboard**: Community statistics, user management, and module configuration
- **Browser Source Management**: Display unique browser source URLs for OBS integration
- **Email Service**: SMTP/sendmail support for notifications and password resets
- **API Key Management**: Generate and manage API keys for programmatic access
- **Audit Trail**: Comprehensive logging of all administrative actions
- **Service Health Monitoring**: Monitor health status of all WaddleBot services

**Technical Details**:
- Routes all API traffic to backend services with authentication
- Per-service rate limits (Router: 1000/min, AI: 1000/min, Triggers: 200/min)
- Browser source URL management with copy-to-clipboard functionality
- CORS support for web applications

---

### Identity Core Module (`core/identity_core_module_flask/`)

**Purpose**: Cross-platform identity linking and verification system with comprehensive API key management

**Key Features**:
- **Flask-Security-Too Foundation**: Built on Flask-Security-Too authentication system with extended user fields
- **Cross-Platform Linking**: Secure identity verification between Discord, Twitch, and Slack accounts
- **Whisper/DM Verification**: Platform-specific verification via whispers and direct messages
- **User API Key Management**: Self-service API key generation with same permissions as user identity
- **Comprehensive Security**: SHA-256 hashed API keys, time-limited verification codes, rate limiting
- **Multi-threaded Processing**: ThreadPoolExecutor for concurrent verification operations
- **Redis Caching**: High-performance caching for identity lookups and session management
- **Comprehensive AAA Logging**: Full Authentication, Authorization, and Auditing with structured output

**Identity Linking Flow**:
1. User types `!identity link twitch username`
2. Verification code sent via whisper/DM to platform account
3. User confirms with `!verify CODE` in chat
4. Identity linked across platforms

**Key Features List**:
- **API Key System**: Users can create, regenerate, and revoke their own API keys for programmatic access
- **Session Management**: Flask session-based authentication with configurable expiration
- **Platform Integration**: Communicates with Twitch, Discord, and Slack collectors for whisper/DM delivery
- **Database Schema**: Extended Flask-Security user table with WaddleBot-specific fields (display_name, primary_platform, reputation_score)
- **Verification Security**: 6-character alphanumeric codes (excluding ambiguous characters) with 10-minute expiration
- **Rate Limiting**: Sliding window rate limiting to prevent spam and abuse
- **Health Monitoring**: Comprehensive health checks for all platform APIs and dependencies

---

### Labels Core Module (`core/labels_core_module_flask/`)

**Purpose**: High-performance multi-threaded label management system for communities, users, modules, and entity groups

**Key Features**:
- **High-Performance Architecture**: Multi-threaded processing with ThreadPoolExecutor (configurable max workers)
- **Redis Caching**: High-performance caching layer with fallback to local cache
- **Bulk Operations**: Support for up to 1000 items per batch operation for high-volume requests
- **Label Management**: Track labels on communities, modules, users, and entityGroups (up to 5 labels per community, 5 per user per community)
- **User Identity Verification**: Time-limited verification codes to link platform identities to bot identities
- **Entity Group Management**: Auto-role assignment in Discord, Slack, and Twitch based on user labels
- **Search Functionality**: Search modules, users, and entities by labels with caching
- **Background Processing**: Asynchronous task queue for long-running operations
- **Performance Monitoring**: Real-time metrics and health monitoring in health endpoint
- **Database Optimization**: Proper indexing and connection pooling for thousands of requests per second

**Technical Details**:
- Label limits: 5 per community, 5 per user per community
- Thread-safe operations with concurrent processing
- Integration with identity system for user verification

---

## Trigger Modules (Receivers)

### Twitch Module (`trigger/receiver/twitch_module_flask/`)

**Purpose**: Twitch EventSub webhook receiver and OAuth integration

**Key Features**:
- **EventSub Webhooks**: Handles follow, subscribe, cheer, raid, gift subscription events
- **OAuth Integration**: Complete OAuth flow with token management and refresh
- **API Integration**: Twitch Helix API for user info and subscription management
- **Activity Points**: follow=10, sub=50, bits=variable, raid=30, subgift=60, ban=-10

**Technical Details**:
- Webhook signature verification (HMAC-SHA256)
- Automatic token refresh and management
- Coordination system for horizontal scaling across multiple containers

---

### Discord Module (`trigger/receiver/discord_module_flask/`)

**Purpose**: Discord bot with py-cord integration for events and slash commands

**Key Features**:
- **py-cord Integration**: Uses py-cord library for Discord bot functionality
- **Event Handling**: Messages, reactions, member joins, voice states, server boosts
- **Slash Commands**: Built-in slash command support with py-cord
- **Voice Tracking**: Tracks voice channel participation with time-based points
- **Activity Points**: message=5, reaction=2, member_join=10, voice_join=8, voice_time=1/min, boost=100

**Technical Details**:
- Native Discord bot with gateway connections
- Voice channel time tracking with point accumulation
- Server boost event handling

---

### Slack Module (`trigger/receiver/slack_module_flask/`)

**Purpose**: Slack app integration with Event API and slash commands

**Key Features**:
- **Event API**: Handles messages, reactions, file shares, channel joins
- **Slash Commands**: Custom `/waddlebot` command with help, status, points subcommands
- **Slack SDK**: Uses official Slack SDK for Python
- **User Caching**: Caches user information for performance
- **Activity Points**: message=5, file_share=15, reaction=3, member_join=10, app_mention=8

**Technical Details**:
- Socket mode support for real-time events
- OAuth flow for workspace installation
- User information caching for performance

---

## Related Documentation

- [module-details-action.md](module-details-action.md) - Action/interactive module details
- [CLAUDE.md](../CLAUDE.md) - Project overview and architecture
- [API Documentation](api-reference.md) - Complete API endpoint reference
- [Environment Variables](environment-variables.md) - Configuration reference
- [Deployment Guide](deployment.md) - Docker and Kubernetes deployment
