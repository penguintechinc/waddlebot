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
