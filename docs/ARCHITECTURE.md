# WaddleBot Architecture

## System Overview

WaddleBot is a multi-platform chat bot system with a modular, microservices architecture. This document describes the data flow and interconnectivity between components.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL PLATFORMS                                  │
├─────────────────────┬─────────────────────┬─────────────────────────────────────┤
│       Discord       │       Twitch        │              Slack                  │
│    (Webhooks/WS)    │    (EventSub)       │         (Events API)                │
└──────────┬──────────┴──────────┬──────────┴──────────┬──────────────────────────┘
           │                     │                     │
           ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           KONG API GATEWAY                                       │
│  - Authentication (API Keys)    - Rate Limiting    - Request Routing            │
│  - Consumer Groups              - CORS             - Load Balancing              │
└──────────┬──────────────────────┬──────────────────────┬────────────────────────┘
           │                      │                      │
           ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  discord_module  │  │  twitch_module   │  │   slack_module   │
│   (Collector)    │  │   (Collector)    │  │   (Collector)    │
│   Port: 8003     │  │   Port: 8002     │  │   Port: 8004     │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            ROUTER MODULE                                         │
│                            Port: 8000                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │ - Command Detection (! local, # community)                              │    │
│  │ - String Matching (moderation, auto-responses)                          │    │
│  │ - Rate Limiting (per user/command/entity)                               │    │
│  │ - Session Management (Redis)                                            │    │
│  │ - Execution Routing (containers, Lambda, OpenWhisk, webhooks)           │    │
│  │ - Response Aggregation                                                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└────────┬───────────────────────┬───────────────────────┬────────────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        INTERACTION MODULES                                       │
├──────────────────┬──────────────────┬──────────────────┬────────────────────────┤
│ ai_interaction   │ shoutout_module  │ inventory_module │ calendar_module        │
│   Port: 8005     │   Port: 8020     │   Port: 8024     │   Port: 8030           │
├──────────────────┼──────────────────┼──────────────────┼────────────────────────┤
│ alias_module     │ memories_module  │ youtube_music    │ spotify_interaction    │
│   Port: 8010     │   Port: 8031     │   Port: 8025     │   Port: 8026           │
└──────────────────┴──────────────────┴──────────────────┴────────────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CORE MODULES                                            │
├──────────────────┬──────────────────┬──────────────────┬────────────────────────┤
│  labels_core     │  identity_core   │ browser_source   │  reputation_module     │
│   Port: 8040     │   Port: 8050     │   Port: 8027     │   Port: 8055           │
├──────────────────┴──────────────────┴──────────────────┴────────────────────────┤
│  community_module │  marketplace     │  kong_admin_broker                       │
│   Port: 8045      │   Port: 8001     │   Port: 8080                             │
└─────────────────────────────────────────────────────────────────────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                             │
├─────────────────────────────────┬───────────────────────────────────────────────┤
│         PostgreSQL              │                  Redis                         │
│    (Primary + Read Replicas)    │           (Sessions, Cache)                   │
│    - Commands, Entities         │           - Session tokens                    │
│    - Users, Communities         │           - Rate limit counters               │
│    - Module configs             │           - Cached permissions                │
│    - Audit logs                 │           - Temporary state                   │
└─────────────────────────────────┴───────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           HUB MODULE (Web UI)                                    │
│                            Port: 8060                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Frontend: React + Tailwind     │     Backend: Express.js + Node.js    │    │
│  ├─────────────────────────────────┼───────────────────────────────────────┤    │
│  │  - Public pages (home, browse)  │     - Auth (OAuth + temp passwords)  │    │
│  │  - Member dashboard             │     - Community API                  │    │
│  │  - Community admin panel        │     - Admin API                      │    │
│  │  - Platform admin panel         │     - Platform API                   │    │
│  └─────────────────────────────────┴───────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Communication Protocols

WaddleBot uses a hybrid communication strategy:

### Protocol Matrix

| Communication Path | Protocol | Notes |
|-------------------|----------|-------|
| External → Kong Gateway | REST/HTTPS | Public API access |
| Kong Gateway → Modules | REST/HTTP | Internal routing |
| Module → Module | **gRPC** | High-performance internal calls |
| Browser Sources | WebSocket | Real-time overlay updates |

### gRPC Port Assignments

Internal module-to-module communication uses gRPC for better performance and type safety:

| Module | REST Port | gRPC Port | Service |
|--------|-----------|-----------|---------|
| discord_action | 8070 | 50051 | DiscordAction |
| slack_action | 8071 | 50052 | SlackActionService |
| twitch_action | 8072 | 50053 | TwitchActionService |
| youtube_action | 8073 | 50054 | YouTubeAction |
| lambda_action | 8080 | 50060 | LambdaAction |
| gcp_functions_action | 8081 | 50061 | GCPFunctionsActionService |
| openwhisk_action | 8082 | 50062 | OpenWhiskActionService |
| reputation | 8021 | 50021 | ReputationService |
| workflow_core | 8070 | 50070 | WorkflowService |
| browser_source | 8050 | 50050 | BrowserSourceService |
| identity_core | 8030 | 50030 | IdentityService |

### gRPC Features

- **Connection pooling**: Reuses channels for efficiency
- **JWT authentication**: Service-to-service auth via tokens
- **Retry logic**: Exponential backoff with configurable retries
- **REST fallback**: Falls back to REST if gRPC unavailable
- **Proto definitions**: Shared protos in `libs/grpc_protos/`

## Data Flow: Chat Message Processing

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CHAT MESSAGE FLOW                                         │
└──────────────────────────────────────────────────────────────────────────────┘

User types: "!play never gonna give you up"

    ┌─────────────┐
    │   Discord   │
    │   Server    │
    └──────┬──────┘
           │ 1. Message event via WebSocket
           ▼
    ┌─────────────┐
    │  discord_   │
    │   module    │
    └──────┬──────┘
           │ 2. Format event, lookup entity
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      ROUTER MODULE                           │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 3. Generate session_id, store in Redis                │  │
    │  │ 4. Detect command prefix (!)                          │  │
    │  │ 5. Lookup command "play" in database                  │  │
    │  │ 6. Check permissions for entity                       │  │
    │  │ 7. Check rate limits                                  │  │
    │  │ 8. Route to interaction module                        │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │  youtube_   │
    │   music     │
    └──────┬──────┘
           │ 9. Search YouTube, queue track
           │ 10. Return response with session_id
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      ROUTER MODULE                           │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 11. Validate session_id                               │  │
    │  │ 12. Process response type (chat, media, ticker)       │  │
    │  │ 13. Route media response to browser_source_core       │  │
    │  │ 14. Return chat response to collector                 │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────┬───────────────────────────────┘
           │                      │
           ▼                      ▼
    ┌─────────────┐        ┌─────────────┐
    │  discord_   │        │  browser_   │
    │   module    │        │   source    │
    └──────┬──────┘        └──────┬──────┘
           │                      │
           ▼                      ▼
    ┌─────────────┐        ┌─────────────┐
    │   Discord   │        │  OBS Studio │
    │   Channel   │        │  (WebSocket)│
    │  "Now play- │        │  [Album art │
    │   ing: ..." │        │   + title]  │
    └─────────────┘        └─────────────┘
```

## Data Flow: OAuth Authentication

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     OAUTH AUTHENTICATION FLOW                                 │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │    User     │
    │   Browser   │
    └──────┬──────┘
           │ 1. Click "Login with Discord"
           ▼
    ┌─────────────┐
    │  hub_module │
    │  (Frontend) │
    └──────┬──────┘
           │ 2. GET /api/v1/auth/oauth/discord
           ▼
    ┌─────────────┐
    │  hub_module │
    │  (Backend)  │
    └──────┬──────┘
           │ 3. Get OAuth URL from identity_core
           ▼
    ┌─────────────┐
    │  identity_  │
    │    core     │
    └──────┬──────┘
           │ 4. Return Discord OAuth URL
           ▼
    ┌─────────────┐
    │   Discord   │
    │   OAuth     │
    └──────┬──────┘
           │ 5. User authorizes, redirect with code
           ▼
    ┌─────────────┐
    │  hub_module │
    │  /callback  │
    └──────┬──────┘
           │ 6. Exchange code for user info via identity_core
           ▼
    ┌─────────────┐
    │  identity_  │
    │    core     │
    └──────┬──────┘
           │ 7. Verify with Discord, return user data
           ▼
    ┌─────────────┐
    │  hub_module │
    │  (Backend)  │
    └──────┬──────┘
           │ 8. Create JWT session, store in DB
           │ 9. Redirect to frontend with token
           ▼
    ┌─────────────┐
    │    User     │
    │  Dashboard  │
    └─────────────┘
```

## Data Flow: Browser Source Updates

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     BROWSER SOURCE FLOW                                       │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │   OBS       │
    │   Studio    │
    └──────┬──────┘
           │ 1. Browser source connects via WebSocket
           │    URL: /browser/source/{token}/media
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                  BROWSER_SOURCE_CORE                         │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 2. Validate token, register connection               │  │
    │  │ 3. Wait for updates via WebSocket                    │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────────────────────────────────────────────────────────────┘
           ▲
           │ 4. Router sends media response
           │
    ┌─────────────┐
    │   Router    │
    │   Module    │
    └──────┬──────┘
           │ 5. POST /browser/source/display
           │    {type: "media", data: {title, artist, art_url}}
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                  BROWSER_SOURCE_CORE                         │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 6. Lookup community's WebSocket connections          │  │
    │  │ 7. Push update to all connected sources              │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │ 8. WebSocket message
           ▼
    ┌─────────────┐
    │   OBS       │
    │   Studio    │
    │  [Shows     │
    │   album art │
    │   + title]  │
    └─────────────┘
```

## Data Flow: Coordination (Horizontal Scaling)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     COORDINATION FLOW                                         │
│           (Multiple collector containers sharing workload)                    │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────────────┐
    │                    COORDINATION TABLE                              │
    │  ┌─────────────────────────────────────────────────────────────┐  │
    │  │ entity_id │ platform │ claimed_by  │ claim_expires │ status │  │
    │  ├───────────┼──────────┼─────────────┼───────────────┼────────┤  │
    │  │ twitch:1  │ twitch   │ container_1 │ 2025-01-01... │ live   │  │
    │  │ twitch:2  │ twitch   │ container_1 │ 2025-01-01... │ idle   │  │
    │  │ twitch:3  │ twitch   │ container_2 │ 2025-01-01... │ live   │  │
    │  │ twitch:4  │ twitch   │ NULL        │ NULL          │ idle   │  │
    │  └─────────────────────────────────────────────────────────────┘  │
    └───────────────────────────────────────────────────────────────────┘
           ▲                                        ▲
           │                                        │
    ┌──────┴──────┐                          ┌──────┴──────┐
    │  twitch_    │                          │  twitch_    │
    │  container_1│                          │  container_2│
    └──────┬──────┘                          └──────┬──────┘
           │                                        │
           │ POST /coordination/claim               │
           │ POST /coordination/heartbeat           │
           │ POST /coordination/status              │
           │                                        │
           ▼                                        ▼
    ┌─────────────┐                          ┌─────────────┐
    │   Twitch    │                          │   Twitch    │
    │  Channels   │                          │  Channels   │
    │  1, 2       │                          │  3          │
    └─────────────┘                          └─────────────┘


CLAIM LIFECYCLE:
1. Container starts → POST /coordination/claim (claims up to 5 entities)
2. Every 5 min → POST /coordination/checkin (renews claims)
3. Container detects offline → POST /coordination/release-offline
4. Container crash → Claims expire after 30 min, other containers claim them
```

## Module Interconnectivity Matrix

| Module | Calls | Called By |
|--------|-------|-----------|
| **router_module** | All interaction modules, browser_source, reputation | All collectors |
| **discord_module** | router_module, identity_core | Kong (webhooks) |
| **twitch_module** | router_module, identity_core | Kong (EventSub) |
| **slack_module** | router_module, identity_core | Kong (Events API) |
| **identity_core** | PostgreSQL, Redis | All auth flows, collectors |
| **browser_source_core** | PostgreSQL | router_module, hub_module |
| **labels_core** | PostgreSQL, Redis | Interaction modules |
| **reputation_module** | PostgreSQL | router_module |
| **marketplace_module** | router_module, PostgreSQL | hub_module |
| **hub_module** | identity_core, All admin APIs | User browsers |
| **ai_interaction** | External AI APIs (Ollama/OpenAI) | router_module |
| **youtube_music** | YouTube API, browser_source | router_module |
| **spotify_interaction** | Spotify API, browser_source | router_module |

## Port Assignments

| Port | Module | Description |
|------|--------|-------------|
| 8000 | router_module | Core command routing |
| 8001 | marketplace_module | Module marketplace |
| 8002 | twitch_module | Twitch collector |
| 8003 | discord_module | Discord collector |
| 8004 | slack_module | Slack collector |
| 8005 | ai_interaction_module | AI chat responses |
| 8010 | alias_interaction_module | Command aliases |
| 8020 | shoutout_interaction_module | User shoutouts |
| 8024 | inventory_interaction_module | Item tracking |
| 8025 | youtube_music_interaction_module | YouTube Music |
| 8026 | spotify_interaction_module | Spotify playback |
| 8027 | browser_source_core_module | OBS overlays |
| 8030 | calendar_interaction_module | Event calendar |
| 8031 | memories_interaction_module | Quotes/URLs |
| 8040 | labels_core_module | Label management |
| 8045 | community_module | Community management |
| 8050 | identity_core_module | Cross-platform identity |
| 8055 | reputation_module | Points/reputation |
| 8060 | hub_module | Web UI (Portal + Hub) |
| 8080 | kong_admin_broker | Kong admin management |

## Database Schema Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         POSTGRESQL TABLES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  CORE TABLES                         COMMUNITY TABLES                        │
│  ─────────────                       ────────────────                        │
│  commands                            communities                             │
│  entities                            community_members                       │
│  command_permissions                 community_activity                      │
│  command_executions                  community_domains                       │
│  coordination                                                                │
│  stringmatch                         USER TABLES                             │
│  module_responses                    ───────────                             │
│                                      hub_sessions                            │
│  MODULE TABLES                       hub_temp_passwords                      │
│  ─────────────                       platform_admins                         │
│  modules                             audit_log                               │
│  module_installations                                                        │
│  collector_modules                   FEATURE TABLES                          │
│                                      ──────────────                          │
│  IDENTITY TABLES                     events (calendar)                       │
│  ───────────────                     memories                                │
│  identity_links                      inventory_items                         │
│  identity_verifications              browser_source_tokens                   │
│  user_api_keys                       labels                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Global Community

WaddleBot maintains a mandatory "Global" community for cross-community reputation tracking and platform-wide statistics.

### Key Characteristics

- **Name**: `waddlebot-global`
- **Membership**: Mandatory and permanent for all users
- **Purpose**: Cross-community reputation tracking, global stats, bad actor detection

### Membership Rules

1. **Auto-Join**: All new users are automatically added on registration
2. **Cannot Leave**: Users cannot voluntarily leave the global community
3. **Cannot Be Removed**: Admins cannot remove members from the global community
4. **Permanent**: Membership persists for the lifetime of the user account

### Use Cases

- Track users who are banned across multiple communities
- Aggregate global statistics and activity metrics
- Enable cross-community reputation sharing
- Identify patterns of bad behavior across the platform

## Module Controls

Community admins can enable or disable modules for their community, including core modules.

### How It Works

1. **Module Installation Table**: `module_installations` tracks which modules are enabled per community
2. **Router Enforcement**: Router checks `is_enabled` before executing commands from a module
3. **Redis Caching**: Module status cached in Redis (5-minute TTL) for performance

### Core vs Non-Core Modules

- **Core modules** (reputation, loyalty, analytics, etc.) are marked with `is_core = true`
- Community admins can disable ANY module, including core ones
- Disabling core modules shows a warning in the admin UI
- This allows communities to use external replacements for built-in features
