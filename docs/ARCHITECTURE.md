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
│   Port: 8005     │   Port: 8011     │   Port: 8024     │   Port: 8030           │
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
│   Port: 8023     │   Port: 8050     │   Port: 8027     │   Port: 8021           │
├──────────────────┴──────────────────┴──────────────────┴────────────────────────┤
│  community_module │  marketplace     │                                          │
│   Port: 8020      │   Port: 8001     │                                          │
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

## Data Flow: Unified Authentication

The Hub uses a **local-login-centric** authentication model where all users have a local account
(email/password) with optional OAuth platform identities linked as spokes.

### Local Login Flow
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     LOCAL LOGIN / REGISTRATION FLOW                           │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │    User     │
    │   Browser   │
    └──────┬──────┘
           │ 1. Enter email + password
           │    (Login or Register)
           ▼
    ┌─────────────┐
    │  hub_module │
    │  (Frontend) │
    └──────┬──────┘
           │ 2. POST /api/v1/auth/login or /register
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      HUB MODULE (Backend)                    │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 3. Validate credentials against hub_users table       │  │
    │  │ 4. Create JWT session (userId, roles, isSuperAdmin)   │  │
    │  │ 5. Store session in hub_sessions table                │  │
    │  │ 6. Return token + user info                           │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │    User     │
    │  Dashboard  │
    └─────────────┘
```

### OAuth Login Flow (Creates/Links Account)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     OAUTH LOGIN FLOW                                          │
│     (If no existing user, creates local account + links platform)            │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │    User     │
    │   Browser   │
    └──────┬──────┘
           │ 1. Click "Continue with Discord"
           ▼
    ┌─────────────┐
    │  hub_module │
    │  (Frontend) │
    └──────┬──────┘
           │ 2. GET /api/v1/auth/oauth/discord
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      HUB MODULE (Backend)                    │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 3. Generate OAuth state (CSRF protection)             │  │
    │  │ 4. Store state in hub_oauth_states table              │  │
    │  │ 5. Return Discord OAuth URL with state                │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │   Discord   │
    │   OAuth     │
    └──────┬──────┘
           │ 6. User authorizes, redirect with code
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      HUB MODULE (Backend)                    │
    │           /api/v1/auth/oauth/discord/callback                │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 7. Verify state from hub_oauth_states                 │  │
    │  │ 8. Exchange code for tokens with Discord              │  │
    │  │ 9. Get user info from Discord API                     │  │
    │  │ 10. Check hub_user_identities for existing link       │  │
    │  │                                                       │  │
    │  │ If existing: Return existing user                     │  │
    │  │ If email matches: Link to existing user               │  │
    │  │ If new: Create hub_users + hub_user_identities        │  │
    │  │                                                       │  │
    │  │ 11. Create JWT session                                │  │
    │  │ 12. Redirect to /auth/callback?token=...              │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │    User     │
    │  Dashboard  │
    └─────────────┘
```

### Platform Linking Flow (Logged-in User)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     PLATFORM LINKING FLOW                                     │
│              (User already logged in, links new platform)                     │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │    User     │   Already logged in via local login
    │  Settings   │   or different OAuth platform
    └──────┬──────┘
           │ 1. Click "Connect Discord"
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      HUB MODULE (Backend)                    │
    │           GET /api/v1/auth/oauth/discord/link                │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 2. Generate state with user_id stored                 │  │
    │  │ 3. Return OAuth URL                                   │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │   Discord   │
    │   OAuth     │
    └──────┬──────┘
           │ 4. User authorizes
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                      HUB MODULE (Backend)                    │
    │           /api/v1/auth/oauth/discord/link-callback           │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ 5. Verify state, get user_id                          │  │
    │  │ 6. Exchange code for user info                        │  │
    │  │ 7. Check if platform already linked to another user   │  │
    │  │ 8. Insert/update hub_user_identities                  │  │
    │  │ 9. Redirect to /dashboard/settings?linked=discord     │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────┬──────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────┐
    │    User     │  Now has Discord linked
    │  Settings   │  to their local account
    └─────────────┘
```

### User Data Model
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     UNIFIED USER DATA MODEL                                   │
└──────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────────────────────────────────────────────────────┐
    │                      hub_users                               │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ id: 1                                                 │  │
    │  │ email: user@example.com       (primary identifier)    │  │
    │  │ username: cooluser                                    │  │
    │  │ password_hash: $2b$12$...     (optional if OAuth-only)│  │
    │  │ avatar_url: https://...                               │  │
    │  │ is_super_admin: false                                 │  │
    │  │ is_active: true                                       │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────────────────────────────────────────────────────────────┘
                                 │
                                 │ 1:N
                                 ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                   hub_user_identities                        │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ hub_user_id: 1                                        │  │
    │  │ platform: discord             (discord/twitch/slack)  │  │
    │  │ platform_user_id: 123456789   (platform's user ID)    │  │
    │  │ platform_username: CoolUser#1234                      │  │
    │  │ avatar_url: https://cdn.discord.../avatar.png         │  │
    │  │ linked_at: 2025-12-03                                 │  │
    │  └───────────────────────────────────────────────────────┘  │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ hub_user_id: 1                                        │  │
    │  │ platform: twitch                                      │  │
    │  │ platform_user_id: 987654321                           │  │
    │  │ platform_username: cooluser_tv                        │  │
    │  │ ...                                                   │  │
    │  └───────────────────────────────────────────────────────┘  │
    └─────────────────────────────────────────────────────────────┘
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
| 8011 | shoutout_interaction_module | User shoutouts |
| 8020 | community_module | Community management |
| 8021 | reputation_module | Points/reputation |
| 8023 | labels_core_module | Label management |
| 8024 | inventory_interaction_module | Item tracking |
| 8025 | youtube_music_interaction_module | YouTube Music |
| 8026 | spotify_interaction_module | Spotify playback |
| 8027 | browser_source_core_module | OBS overlays |
| 8030 | calendar_interaction_module | Event calendar |
| 8031 | memories_interaction_module | Quotes/URLs |
| 8050 | identity_core_module | Cross-platform identity |
| 8060 | hub_module | Web UI (Portal + Admin) |
| 9000 | minio | S3-compatible storage API |
| 9001 | minio | MinIO console |

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
│  ─────────────                       hub_oauth_states                        │
│  modules                             platform_configs                        │
│  module_installations                audit_log                               │
│  collector_modules                                                           │
│                                      FEATURE TABLES                          │
│  IDENTITY TABLES                     ──────────────                          │
│  ───────────────                     events (calendar)                       │
│  hub_users                           memories                                │
│  hub_user_identities                 inventory_items                         │
│  user_api_keys                       browser_source_tokens                   │
│                                      labels                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```
