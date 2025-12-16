# WaddleBot Project Context

## Project Overview

WaddleBot is a multi-platform chat bot system with a modular, microservices architecture. The system consists of:

- **Trigger Modules**: Platform-specific modules that START the workflow by receiving webhooks/events or polling
  - **Receiver Modules**: Receive webhooks/events from platforms like Twitch, Discord, Slack
  - **Poller Modules**: Poll sources on cron schedules (e.g., IRC)
  - **Cron Modules**: Timed actions and scheduled tasks
- **Processing Module**: Central router/API server that processes events and routes to action modules
- **Action Modules**: Response modules that execute after processing
  - **Interactive Modules**: Return responses to users (AI, alias, shoutout, inventory, etc.)
  - **Pushing Modules**: Push to external systems and webhooks
  - **Security Modules**: Content moderation and security checks
- **Core Modules**: Core platform services (identity, labels, browser source, reputation, community)
- **Admin Modules**: Administrative interfaces (hub_module for community management)
- **Database**: PostgreSQL with read replicas for configuration, routing, logins, roles, etc.

## Module Terminology

| Category | Subcategory | Purpose | Examples |
|----------|-------------|---------|----------|
| `trigger/` | `receiver/` | Receives webhooks/events | twitch, discord, slack |
| `trigger/` | `poller/` | Polls sources on cron | IRC |
| `trigger/` | `cron/` | Timed actions | periodic messages |
| `processing/` | - | Main router/API server | router_module |
| `action/` | `interactive/` | Returns responses | shoutout, ai, alias, inventory, calendar, memories, youtube_music, spotify |
| `action/` | `pushing/` | Pushes to external systems | webhooks |
| `action/` | `security/` | Security/moderation | content filtering |
| `core/` | - | Platform services | identity, labels, browser_source, reputation, community |
| `admin/` | - | Administrative UIs | hub_module |
| `archive/` | - | Legacy/deprecated | chat, gateway, listener, marketplace, kong_admin_broker |

## Architecture

### Technology Stack
- **Primary Framework**: Flask/Quart on Python 3.13
- **Routing**: Hub module handles direct routing (Kong removed)
- **Database**: AsyncDAL wrapper around PyDAL with PostgreSQL and read replicas
- **Session Management**: Redis for session ID tracking
- **Internal Communication**: gRPC for module-to-module calls (with REST fallback)
- **Proto Definitions**: Shared protobuf files in `libs/grpc_protos/`
- **Containerization**: Docker containers
- **Orchestration**: Kubernetes (longer term)
- **Cloud Functions**: AWS Lambda and Apache OpenWhisk (longer term) for actions
- **Authentication**: API Key authentication with role-based access control
- **Future Migration**: Parts may migrate to Golang later

### Core Components
- **Processing (Router)**: Flask/Quart-based API layer that handles event routing and action module execution
- **Trigger (Receivers)**: Individual Docker containers that receive webhooks/events from platforms
- **Action (Interactive/Pushing/Security)**: Docker containers that execute responses and actions
- **Core Services**: Platform services for identity, labels, browser sources, reputation, and community management
- **Database**: PostgreSQL storing servers, routes, logins, roles, permissions, module registrations

### Trigger (Receiver) Architecture
Each trigger/receiver module:
- Runs as its own Docker container
- Built on Flask/Quart with Python 3.13
- Pulls monitored servers/channels from PostgreSQL `servers` table
- Communicates with processing module (router) via API when receiving chat/events
- Registers itself with router API
- Designed for handling 1000+ chat channels at a time
- All configuration comes from environment variables passed through docker

## Current Implementation

### Processing Module
- **router_module/**: High-performance command router with multi-threading, caching, and read replicas

### Trigger Modules (Receivers)
- **twitch_module/**: Complete Twitch collector with EventSub webhooks, OAuth, and API integration
- **discord_module/**: Discord collector using py-cord library for bot events and slash commands
- **slack_module/**: Slack collector using Slack SDK for events and slash commands

### Action Modules (Interactive)
- **ai_interaction_module/**: AI-powered interaction supporting Ollama, OpenAI, and MCP providers
- **alias_interaction_module/**: Linux-style alias system for custom commands
- **shoutout_interaction_module/**: Platform-specific user shoutouts with Twitch API integration
- **inventory_interaction_module/**: Multi-threaded inventory management system
- **calendar_interaction_module/**: Event management with approval workflows and recurring events
- **memories_interaction_module/**: Community memory management for quotes, reminders, URLs
- **youtube_music_interaction_module/**: YouTube Music integration with browser source output
- **spotify_interaction_module/**: Spotify integration with OAuth and playback control

### Core Modules
- **identity_core_module/**: Cross-platform identity linking with Flask-Security-Too
- **labels_core_module/**: High-performance label management system
- **browser_source_core_module/**: OBS browser source integration with WebSocket
- **reputation_module/**: User reputation and activity tracking
- **community_module/**: Community management and configuration

### Admin Modules
- **hub_module/**: Community portal with authentication, dashboard, and direct routing

### Shared Libraries
- **libs/flask_core/**: Shared Flask/Quart utilities (AsyncDAL, auth, datamodels, logging, API utils)

### Archive (Deprecated/Legacy)
- **marketplace_module/**: (DEPRECATED - moved to hub_module)
- **kong_admin_broker/**: (REMOVED - Kong no longer used)
- **chat/**: (LEGACY - Matterbridge integration)
- **gateway/**: (DEPRECATED - migrated to hub_module)
- **listener/**: (LEGACY - Twitch listeners)

## File Structure
```
WaddleBot/
├── trigger/                          # Modules that START the workflow
│   ├── receiver/                     # Webhook/event receivers
│   │   ├── twitch_module_flask/     # Twitch EventSub webhooks, OAuth
│   │   ├── discord_module_flask/    # Discord py-cord bot events
│   │   └── slack_module_flask/      # Slack SDK events
│   ├── poller/                       # Cron-based polling (future)
│   └── cron/                         # Timed actions (future)
├── processing/                       # Main API server
│   └── router_module_flask/         # High-performance command router
├── action/                           # Response/action modules
│   ├── interactive/                 # Return responses to users
│   │   ├── ai_interaction_module_flask/
│   │   ├── alias_interaction_module_flask/
│   │   ├── shoutout_interaction_module_flask/
│   │   ├── inventory_interaction_module_flask/
│   │   ├── calendar_interaction_module_flask/
│   │   ├── memories_interaction_module_flask/
│   │   ├── youtube_music_interaction_module_flask/
│   │   └── spotify_interaction_module_flask/
│   ├── pushing/                     # Push to external systems (future)
│   └── security/                    # Security/moderation (future)
├── core/                             # Core platform services
│   ├── identity_core_module_flask/
│   ├── labels_core_module_flask/
│   ├── browser_source_core_module_flask/
│   ├── reputation_module_flask/
│   └── community_module_flask/
├── admin/                            # Administrative modules
│   └── hub_module/                  # Community portal
├── archive/                          # Legacy/deprecated modules
├── libs/                             # Shared libraries
│   └── flask_core/                  # Shared Flask/Quart utilities
├── config/                           # Shared configurations
│   ├── nginx/                       # Nginx reverse proxy configs
│   └── postgres/                    # PostgreSQL database configs
├── docs/                             # Documentation
└── Premium/                          # Premium mobile applications
    ├── Android/                      # Native Android app (Kotlin)
    └── iOS/                          # Native iOS app (Swift)
```

## Detailed Documentation

For comprehensive details, see the documentation in the `docs/` folder:

| Document | Description |
|----------|-------------|
| [docs/api-reference.md](docs/api-reference.md) | All API endpoints, authentication, rate limiting |
| [docs/database-schema.md](docs/database-schema.md) | PostgreSQL schemas for all modules |
| [docs/environment-variables.md](docs/environment-variables.md) | Environment variable reference for all modules |
| [docs/module-details-core.md](docs/module-details-core.md) | Core, trigger, and hub module details |
| [docs/module-details-action.md](docs/module-details-action.md) | Action module details (AI, music, etc.) |
| [docs/event-processing.md](docs/event-processing.md) | Event flows, message types, execution |
| [docs/shared-patterns.md](docs/shared-patterns.md) | Router, string matching, response system |
| [docs/development-rules.md](docs/development-rules.md) | Development standards and quality requirements |
| [docs/flask-conversion.md](docs/flask-conversion.md) | Flask/Quart conversion and CI/CD process |

## Development Guidelines

### Code Patterns
- **Native Library Usage**: Always prioritize native functionality of specified libraries
- Follow existing WaddleBot dataclass patterns
- Use environment variables for all configuration
- Implement proper logging and error handling
- Follow security best practices (webhook signature verification, token management)

### Comprehensive Logging (AAA)
All modules MUST implement Authentication, Authorization, and Auditing logging:
- **Console**: All logs to stdout/stderr for container orchestration
- **File Logging**: Structured logs to `/var/log/waddlebotlog/` with rotation
- **Log Categories**: AUTH, AUTHZ, AUDIT, ERROR, SYSTEM
- **Log Structure**: `[timestamp] LEVEL module:version EVENT_TYPE community=X user=Y action=Z result=STATUS`

### Performance Considerations
- **Threading**: ThreadPoolExecutor for concurrent operations (10-20 workers)
- **Database**: Separate tables per module for better locking performance
- **Bulk Operations**: Implement bulk processing methods
- **Caching**: Redis caching for frequently accessed data
- **Connection Pooling**: Database connection pooling for high-concurrency

### Docker/Kubernetes
- Each module is a separate container
- Use proper health checks and readiness probes
- Include resource limits and autoscaling
- Secure with non-root users and read-only filesystems
- Environment-based configuration

## Command Prefix Architecture

- **`!` (Local Container Modules)**: Interaction modules in local containers
  - Fast execution (container-to-container)
  - Maintains state and connections
  - Examples: `!help`, `!stats`, `!admin`

- **`#` (Community Modules)**: Marketplace modules in Lambda/OpenWhisk
  - Serverless execution for scalability
  - Community-contributed
  - Examples: `#weather`, `#translate`, `#game`

## Critical Development Rules

**NEVER take shortcuts - ALWAYS prioritize safety, stability, and feature completeness**

### Core Principles
- No quick fixes or partial solutions
- Complete features with proper error handling
- Security, data integrity, and fault tolerance are non-negotiable
- No technical debt - address issues properly the first time
- Use task agents with cheaper models when possible (Haiku or Sonnet if must) to shart out jobs to smartly use tokens

### Global Community

All users are automatically and permanently members of the `waddlebot-global` community for cross-community reputation tracking. Users cannot leave and cannot be removed from this community.

### Module Controls

Community admins can enable/disable any module (including core modules) via the admin UI. The router enforces module status before executing commands.

### Git Workflow
- **NEVER commit automatically** unless explicitly requested
- **NEVER push to remote repositories** under any circumstances
- **ONLY commit when explicitly asked**

### Local State Management
- **ALWAYS maintain local .PLAN and .TODO files** for crash recovery
- Both files must be in .gitignore

### Quality Requirements
- **Linting**: flake8, black, isort, mypy, bandit (Python); ESLint, Prettier (JS); golangci-lint (Go)
- **Security**: Dependabot alerts, Socket.dev, pip-audit, npm audit
- **Builds**: All Python builds in Docker containers, never mark complete until build verified

### File Size Limits
- **Maximum**: 25,000 characters for ALL code and markdown files
- **CLAUDE.md exception**: Maximum 39,000 characters
- **Strategy**: Create detailed docs in `docs/` folder and link from CLAUDE.md

For complete development rules, see [docs/development-rules.md](docs/development-rules.md).

## Integration Points

### Hub Module Direct Routing
All WaddleBot APIs route through the Hub Module for centralized routing, authentication, and rate limiting.

**Key Services**:
- Router Service: `http://router-service:8000`
- AI Interaction: `http://ai-interaction:8005`
- Identity Core: `http://identity-core:8050`

**Authentication**: API Key via `X-API-Key` header with RBAC (roles: trigger, action, core, admin, user)

For complete API reference, see [docs/api-reference.md](docs/api-reference.md).

### Communication Protocols

| Path | Protocol |
|------|----------|
| External → Kong | REST |
| Kong → Module | REST |
| Module → Module | gRPC |

gRPC ports follow the pattern: 50XXX (e.g., discord_action: 50051, reputation: 50021)

## License & External Integrations

### PenguinTech License Server
- **URL**: `https://license.penguintech.io`
- **Key Format**: `PENG-XXXX-XXXX-XXXX-XXXX-ABCD`
- **Note**: License enforcement only enabled when `RELEASE_MODE=true`

### WaddleAI Integration
For advanced AI beyond built-in AI module, integrate with WaddleAI at `~/code/WaddleAI`.

### Version Management
**Format**: `vMajor.Minor.Patch.build`
```bash
./scripts/version/update-version.sh          # Increment build
./scripts/version/update-version.sh patch    # Increment patch
./scripts/version/update-version.sh minor    # Increment minor
./scripts/version/update-version.sh major    # Increment major
```

## .WORKFLOW Compliance

WaddleBot implements comprehensive .WORKFLOW compliance with automated CI/CD, version monitoring, and multi-language security scanning.

### Version Monitoring
- **Version File**: `.version` at repository root (currently: 0.2.0)
- **Version File Triggers**: All module builds automatically trigger when `.version` changes
- **Epoch64 Integration**: Container labels include Unix timestamp of build time
- **Automatic Releases**: Version-release workflow creates GitHub Releases

### Multi-Language Security Scanning
- **Python**: pip-audit, bandit, flake8, black, isort, mypy
- **JavaScript/Node.js**: npm audit, ESLint, Prettier
- **Go**: gosec, golangci-lint (if applicable)
- **Kotlin**: Kotlin linting, Detekt, security analysis
- **Integrated Scanners**: Trivy (filesystem), CodeQL (static), Dependency Review

### 24+ Module Container Management
- **Router Module**: Central request routing (port 8000)
- **Trigger Modules**: Twitch, Discord, Slack, YouTube Live (ports 8010-8013)
- **Core Modules**: Identity, Labels, Browser Source, Community, Reputation, Security, Analytics, Workflow (ports 8050-8070)
- **Action Modules**: AI, Alias, Shoutout, Inventory, Calendar, Memories, YouTube Music, Spotify, Loyalty (ports 8005-8017)
- **Admin Hub**: Community management portal (port 8060)
- **Mobile Apps**: Android (Kotlin) and iOS (Swift)

**Container Registry**: GitHub Container Registry (ghcr.io)
- Image pattern: `ghcr.io/{owner}/waddlebot/{module}:{version}`
- Tags by context: v{version} (release), v{version}-beta (main), v{version}-alpha (feature)
- Multi-platform: linux/amd64 and linux/arm64

### Automated CI/CD Pipeline
- **Security Checks**: Trivy, CodeQL, pip-audit, npm audit, dependency review
- **Container Builds**: Individual workflows for all 24+ modules
- **Reusable Template**: Shared build-container.yml for consistency
- **Version Release**: Automated workflow creates GitHub Release on .version change
- **Pull Request Checks**: All security and dependency checks on PRs

### Documentation
- **docs/WORKFLOWS.md**: Complete CI/CD and version management documentation
- **docs/STANDARDS.md**: Microservices architecture patterns and best practices
- **.CI-CD-SETUP.md**: Version-based container tagging strategy

## Next Steps

1. **Complete Core Migration**: Migrate gateway from Flask to py4web
2. **Lambda Integration**: Connect action modules to AWS Lambda
3. **Kubernetes Deployment**: Full K8s deployment with monitoring
4. **Additional Collectors**: Matrix, Teams, IRC following established patterns
5. **Golang Migration**: Evaluate performance-critical components for Golang migration

## Security Considerations

- All webhooks must verify signatures (HMAC-SHA256 for Twitch)
- OAuth tokens stored securely with automatic refresh
- Database credentials in Kubernetes secrets
- Non-root containers with read-only filesystems
- Rate limiting on ingress
- HTTPS/TLS termination at ingress level

---

*This context should be referenced for all future development to maintain consistency with the overall WaddleBot architecture and patterns.*

*For detailed information, see the comprehensive documentation in the `docs/` folder.*
