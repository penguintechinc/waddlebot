# WaddleBot - Claude Code Context

## Project Overview

WaddleBot is a multi-platform chatbot system with a modular, microservices architecture. This document provides context for Claude Code development, with comprehensive standards documented separately.

**WaddleBot Features:**
- Multi-platform chat integration (Twitch, Discord, Slack, YouTube)
- Modular microservices architecture with 27+ services
- Event-driven processing with trigger→routing→action pipeline
- Enterprise licensing integration with PenguinTech License Server
- Community-based multi-tenancy with role-based access control
- High-performance command routing with caching and read replicas
- License-gated enterprise features (SSO, AI, custom integrations)
- Multi-platform live streaming via video proxy (Twitch, Kick, YouTube, Custom RTMP)
- WebRTC-based community calls via LiveKit (scalable to 1000+ users)
- Community engagement (polls, forms) with granular visibility controls

**System Architecture:**
- **Trigger Modules**: Platform-specific webhooks/events receivers and pollers
- **Processing Module**: Central router for event routing and command execution
- **Action Modules**: Interactive, pushing, and security response modules
- **Core Modules**: Platform services (identity, labels, browser source, reputation, community)
- **Admin Modules**: Community management portal (hub_module)
- **Database**: PostgreSQL (primary) with read replicas, MySQL, SQLite (dev)

## Technology Stack

### Languages & Frameworks
- **Python 3.13**: Primary language for all WaddleBot modules
  - Flask/Quart frameworks for HTTP services
  - AsyncDAL wrapper for database operations
  - gRPC support for service-to-service communication
- **Node.js 18+**: Frontend WebUI and web services
- **Go 1.23.x**: High-performance components (module_rtc for WebRTC/LiveKit)

### Infrastructure & DevOps
- **Containerization**: Docker with multi-stage builds for all modules
- **Container Architecture**: 24+ separate containers per module
  - Backend API container with router, processing, core services
  - WebUI container with frontend and static assets
  - Trigger containers for each platform (Twitch, Discord, Slack, YouTube)
  - Action module containers for each interaction type
- **Orchestration**: Kubernetes ready (docker-compose for local development)
- **Configuration Management**: Environment variables for all modules
- **CI/CD**: GitHub Actions for automated building and security scanning
- **Monitoring**: Prometheus metrics and health endpoints

### Databases & Storage
- **Primary**: PostgreSQL with read replicas for scaling
- **Alternatives**: MySQL/MariaDB with Galera clustering, SQLite (development only)
- **Hybrid Approach**:
  - SQLAlchemy: Database initialization and schema creation
  - PyDAL + AsyncDAL: Day-to-day operations and migrations
- **Session Storage**: Redis for session ID tracking and caching
- **Database Configuration**: DB_TYPE environment variable controls backend

### Security & Authentication
- **Flask-Security-Too**: Mandatory for authentication and RBAC
- **API Key Authentication**: X-API-Key header with role-based access control
- **Webhook Verification**: HMAC-SHA256 signature verification
- **OAuth Integration**: Platform-specific OAuth (Twitch, Discord, Slack)
- **TLS**: Enforce TLS 1.2 minimum, prefer TLS 1.3
- **Secrets**: Environment variable management (no hardcoded credentials)

### Communication Protocols
- **REST API**: Primary protocol for external API access and webhooks
- **gRPC**: Internal service-to-service communication (50XXX port range)
- **WebSocket**: Real-time browser source and live updates
- **Internal Routing**: Hub module for centralized routing and authentication

## PenguinTech License Server Integration

All WaddleBot projects integrate with the centralized PenguinTech License Server at `https://license.penguintech.io` for feature gating and enterprise functionality.

**IMPORTANT: License enforcement is ONLY enabled when project is marked as release-ready**
- Development phase: All features available, no license checks
- Release phase: License validation required, feature gating active

**Enterprise Features** (License-Gated):
- SSO (SAML, OAuth2, OIDC)
- Advanced AI capabilities beyond built-in AI module
- Custom integrations and webhooks
- Audit logging and compliance
- Multi-tenancy advanced features
- Priority support and SLAs

📚 **License Configuration**: See environment variable setup below

## Project Structure

```
WaddleBot/
├── .github/                      # CI/CD pipelines
│   └── workflows/                # GitHub Actions for each module
├── trigger/                      # Modules that START the workflow
│   ├── receiver/                 # Webhook/event receivers
│   │   ├── twitch_module_flask/
│   │   ├── discord_module_flask/
│   │   └── slack_module_flask/
│   ├── poller/                   # Cron-based polling
│   └── cron/                     # Timed actions
├── processing/                   # Main router/API server
│   └── router_module_flask/
├── action/                       # Response/action modules
│   ├── interactive/              # Interactive modules (AI, alias, etc.)
│   ├── pushing/                  # External system integrations
│   └── security/                 # Security/moderation modules
├── core/                         # Core platform services
│   ├── identity_core_module_flask/
│   ├── labels_core_module_flask/
│   ├── browser_source_core_module_flask/
│   ├── reputation_module_flask/
│   ├── community_module_flask/
│   ├── video_proxy_module/       # Multi-platform streaming (Python/Quart)
│   ├── module_rtc/               # WebRTC community calls (Go/LiveKit)
│   └── engagement_module/        # Polls and forms (Python/Quart)
├── admin/                        # Administrative modules
│   └── hub_module/               # Community management portal
├── archive/                      # Legacy/deprecated modules
├── libs/                         # Shared libraries
│   └── flask_core/               # Shared Flask/Quart utilities
├── config/                       # Shared configurations
├── docs/                         # Documentation
├── k8s/                          # Kubernetes templates (future)
├── Premium/                      # Mobile applications
│   ├── Android/                  # Kotlin native app
│   └── iOS/                      # Swift native app
├── docker-compose.yml            # Production environment
├── docker-compose.dev.yml        # Local development
├── Makefile                      # Build automation
├── .version                      # Version tracking
└── CLAUDE.md                     # This file
```

### Module Categories

| Category | Purpose | Examples |
|----------|---------|----------|
| **trigger/receiver** | Webhook/event receivers | Twitch, Discord, Slack, YouTube |
| **trigger/poller** | Cron-based polling | IRC, email |
| **trigger/cron** | Scheduled tasks | Periodic messages, cleanup |
| **processing** | Event routing & command execution | Router module |
| **action/interactive** | User-facing responses | AI, alias, shoutout, inventory, calendar, memories, music |
| **action/pushing** | External system integration | Webhooks, notifications |
| **action/security** | Moderation & security | Content filtering, spam detection |
| **core** | Platform services | Identity, labels, browser source, reputation, community, video proxy, module_rtc, engagement |
| **admin** | Administrative interfaces | Hub module, settings portal |
| **archive** | Legacy/deprecated | Kong admin, marketplace (old) |

## Development Workflow

### Claude Code Model Strategy

**Opus Model (Planning & Orchestration Only)**:
- Opus MUST ONLY be used for planning and orchestrating multi-step tasks
- Opus MUST NEVER implement code directly
- Use Opus for user communication and final reviews

**Task Agent Model Selection**:
- **Haiku (Default)**: Straightforward implementation tasks, Docker operations, single/multi-file changes
- **Sonnet (Complex Tasks)**: Multi-file architectural changes, algorithm implementation, performance optimization
- **Opus (Planning Only)**: Never for implementation

### Local Development Setup

```bash
git clone <repository-url>
cd WaddleBot
make setup          # Install dependencies
make dev            # Start development environment with docker-compose
```

### Essential Commands

```bash
# Development
make dev              # Start development services
make test             # Run all tests
make lint             # Run linting checks
make build            # Build all containers
make clean            # Clean build artifacts

# Testing
make test-unit        # Run unit tests only
make test-integration # Run integration tests
make test-coverage    # Run tests with coverage report

# Deployment
make docker-build     # Build all containers
make docker-push      # Push to registry
make deploy-dev       # Deploy to development environment
make deploy-prod      # Deploy to production

# Version Management
make version-patch    # Increment patch version
make version-minor    # Increment minor version
make version-major    # Increment major version
```

## Critical Development Rules

### Development Philosophy: Safe, Stable, and Feature-Complete

**NEVER take shortcuts - ALWAYS prioritize safety, stability, and feature completeness**

#### Core Principles
- **No Quick Fixes**: Resist quick workarounds or partial solutions
- **Complete Features**: Fully implemented with proper error handling and validation
- **Safety First**: Security, data integrity, and fault tolerance are non-negotiable
- **Stable Foundations**: Build on solid, tested components
- **Future-Proof Design**: Consider long-term maintainability and scalability
- **No Technical Debt**: Address issues properly the first time

#### Red Flags (Never Do These)
- ❌ Skipping input validation "just this once"
- ❌ Hardcoding credentials or configuration
- ❌ Ignoring error returns or exceptions
- ❌ Commenting out failing tests to make CI pass
- ❌ Deploying without proper testing
- ❌ Using deprecated or unmaintained dependencies
- ❌ Implementing partial features with "TODO" placeholders
- ❌ Bypassing security checks for convenience
- ❌ Leaving debug code or backdoors in production

#### Quality Checklist Before Completion
- ✅ All error cases handled properly
- ✅ Unit tests cover all code paths
- ✅ Integration tests verify component interactions
- ✅ Security requirements fully implemented
- ✅ Performance meets acceptable standards
- ✅ Documentation complete and accurate
- ✅ Code review standards met
- ✅ No hardcoded secrets or credentials
- ✅ Logging and monitoring in place
- ✅ Build passes in containerized environment
- ✅ No security vulnerabilities in dependencies
- ✅ Edge cases and boundary conditions tested

### Git Workflow
- **NEVER commit automatically** unless explicitly requested by the user
- **NEVER push to remote repositories** under any circumstances
- **ONLY commit when explicitly asked** - never assume commit permission
- Always use feature branches for development
- Require pull request reviews for main branch
- Automated testing must pass before merge

### Security Scanning (Before Every Commit)
- **Python packages**: Run `pip-audit`, `bandit`, `flake8`, `black`, `isort`, `mypy`
- **Node.js packages**: Run `npm audit`
- **Do NOT commit if security vulnerabilities are found** - fix all issues first
- Document vulnerability fixes in commit message if applicable

### API Testing (Before Every Commit)
- Create and run API testing scripts for each modified module
- Test scope: All new endpoints and modified functionality
- Test files location: `tests/api/` directory with module-specific subdirectories
- Test coverage: Health checks, authentication, CRUD operations, error cases
- Must pass completely before commit

### Linting & Code Quality Requirements
- **Python**: flake8, black, isort, pytest, mypy (type checking), bandit (security)
- **JavaScript/Node.js**: ESLint, Prettier, TypeScript
- **Kotlin/Swift**: Project-specific linters
- **ALL code must pass linting** before commit - no exceptions
- **CodeQL**: All code must pass CodeQL security analysis

### Build & Deployment Requirements
- **NEVER mark tasks as completed until successful build verification**
- All Python builds MUST be executed within Docker containers
- Use containerized builds for local development and CI/CD pipelines
- Build failures must be resolved before task completion

### Local State Management (Crash Recovery)
- **ALWAYS maintain local .PLAN and .TODO files** for crash recovery
- Keep .PLAN file updated with current implementation plans and progress
- Keep .TODO file updated with task lists and completion status
- Update these files in real-time as work progresses
- Add to .gitignore: Both .PLAN and .TODO files must be in .gitignore
- File format: Use simple text format for easy recovery
- Automatic recovery: Upon restart, check for existing files to resume work

### Dependency Security Requirements
- **ALWAYS check for Dependabot alerts** before every commit
- **Monitor vulnerabilities via Socket.dev** for all dependencies
- **Mandatory security scanning** before any dependency changes
- **Fix all security alerts immediately** - no commits with outstanding vulnerabilities
- **Regular security audits**: `pip-audit`, `npm audit`, `bandit`

## Architecture Overview

### Three-Container Deployment Model

This template provides three primary container types representing the core footprints:

| Container | Purpose | Technology |
|-----------|---------|-----------|
| **Backend API** | Router, processing, core services | Flask/Quart + PyDAL |
| **WebUI** | Frontend web application | Node.js + React |
| **Trigger Receivers** | Platform-specific event collectors | Flask/Quart per platform |

### Event Processing Pipeline

```
External Events (Webhooks/Webhooks)
           ↓
    Trigger Receivers
    (Twitch/Discord/Slack)
           ↓
    Router Module
    (command parsing, routing)
           ↓
    Action Modules
    (AI, alias, shoutout, etc.)
           ↓
    Response to User/Platform
```

### Default Roles (RBAC)

| Role | Permissions |
|------|-------------|
| **Admin** | Full access: module management, user CRUD, settings, all features |
| **Maintainer** | Read/write access to resources, no user management |
| **Viewer** | Read-only access to resources |
| **Moderator** | Security and moderation functions |

## Development Standards

Comprehensive development standards are documented separately to keep this file concise.

📚 **Complete Standards Documentation**: [Development Standards](docs/STANDARDS.md)

### Quick Reference

**API Versioning**:
- ALL REST APIs MUST use versioning: `/api/v{major}/endpoint` format
- Semantic versioning for major versions only in URL
- Support current and previous versions (N-1) minimum
- Add deprecation headers to old versions
- Document migration paths for version changes

**Database Standards**:
- **Hybrid approach**: SQLAlchemy for initialization, PyDAL for day-to-day operations
- DB_TYPE environment variable: `postgres`, `mysql`, or `sqlite` only
- Thread-safe usage with thread-local connections
- Environment variable configuration for all database settings
- Connection pooling and retry logic required

**Protocol Support**:
- REST API (primary), gRPC (internal), WebSocket (real-time)
- Environment variables for protocol configuration
- Multi-protocol implementation required

**Performance Optimization**:
- Dataclasses with slots mandatory (30-50% memory reduction)
- Type hints required for all Python code
- asyncio for I/O-bound operations
- threading for blocking I/O with legacy libraries
- multiprocessing for CPU-bound operations
- Profile first before premature optimization

**High-Performance Networking**:
- XDP (eXpress Data Path) and AF_XDP reserved for extreme traffic (>100K packets/sec)
- Use only for network-intensive applications requiring ultra-low latency
- Evaluate Python vs Go based on traffic requirements

**Microservices Architecture**:
- Backend API, WebUI, and Trigger containers are **separate by default**
- Single responsibility per service
- API-first design
- Independent deployment and scaling
- Each service owns its data

**Docker Standards**:
- Multi-arch builds (amd64/arm64)
- Debian-slim base images
- Docker Compose for local development
- Minimal host port exposure
- Non-root users in containers
- Health check endpoints required

**Testing**:
- Unit tests: Network isolated, mocked dependencies
- Integration tests: Component interactions with test databases
- E2E tests: Critical workflows in staging environment
- Performance tests: Scalability and load validation

**Security**:
- TLS 1.2+ required for all connections
- Input validation mandatory on all endpoints
- JWT, MFA, mTLS standard
- SSO as enterprise feature only
- Webhook signature verification required
- No hardcoded secrets ever

## Shared Libraries & Patterns

### flask_core Library

Located at `libs/flask_core/`, provides:
- AsyncDAL wrapper for database operations
- Authentication and RBAC utilities
- Data models and validation
- Logging and monitoring helpers
- API utilities and middleware
- gRPC support for service-to-service communication

### Environment Variables

All modules must support:
```bash
# Database Configuration
DB_TYPE=postgres              # postgres, mysql, or sqlite
DB_HOST=localhost
DB_PORT=5432
DB_NAME=waddlebot
DB_USER=waddlebot
DB_PASS=password
DB_POOL_SIZE=10

# Module Configuration
MODULE_NAME=module_name
MODULE_PORT=8000
MODULE_VERSION=1.0.0

# License Configuration
RELEASE_MODE=false            # Development (default)
LICENSE_KEY=PENG-XXXX-XXXX-XXXX-XXXX-ABCD

# Logging
LOG_LEVEL=INFO               # DEBUG, INFO, WARNING, ERROR, CRITICAL
LOG_FORMAT=text              # text or json

# Redis (if applicable)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

## Troubleshooting & Support

### Common Issues
1. **Port Conflicts**: Check docker-compose port mappings
2. **Database Connections**: Verify connection strings and permissions
3. **Module Registration**: Ensure module registers with router on startup
4. **License Validation**: Check license key format and network connectivity
5. **Build Failures**: Check dependency versions and Docker build output

### Debug Commands
```bash
# Container debugging
docker logs <container-name>
docker exec -it <container-name> /bin/bash

# Application debugging
make test-debug              # Debug tests
make logs                    # View application logs
make health                  # Check service health

# License debugging
curl http://localhost:8000/api/v1/license/status
```

### Support Resources
- **Technical Documentation**: [Development Standards](docs/STANDARDS.md)
- **API Reference**: [docs/reference/api-reference.md](docs/reference/api-reference.md)
- **Architecture**: [docs/architecture/](docs/architecture/)
- **Integration Support**: support@penguintech.io
- **License Server Status**: https://status.penguintech.io

## Related Documentation

- **API Reference**: [docs/reference/api-reference.md](docs/reference/api-reference.md)
- **Architecture**: [docs/architecture/](docs/architecture/)
- **Guides**: [docs/guides/](docs/guides/)
- **Integration Details**: [docs/core-modules/details.md](docs/core-modules/details.md)
- **Action Modules**: [docs/interaction-modules/details.md](docs/interaction-modules/details.md)

---

**CLAUDE.md Version**: 2.0 (Gold Standard Template)
**Last Updated**: 2025-12-18
**Maintained by**: Penguin Tech Inc Engineering Team
**License Server**: https://license.penguintech.io

**Key Updates in v2.0:**
- Aligned with PenguinTech gold standard template
- Enterprise licensing integration
- Modern microservices architecture (24+ services)
- Comprehensive security and quality standards
- Multi-platform support (Twitch, Discord, Slack, YouTube)
- Role-based access control and community management
- Complete development workflow and standards
- License-gated enterprise features

*This context should be referenced for all future development to maintain consistency with WaddleBot architecture and the PenguinTech gold standard patterns.*

*For comprehensive standards and detailed implementation guidance, see [docs/STANDARDS.md](docs/STANDARDS.md).*

---

## File Size Limits

- **Maximum file size**: 25,000 characters for ALL code and markdown files
- **Split large files**: Decompose into modules, libraries, or separate documents
- **CLAUDE.md exception**: Maximum 39,000 characters (only exception to 25K rule)
- **High-level approach**: CLAUDE.md contains high-level context and references detailed docs
- **Documentation strategy**: Create detailed documentation in `docs/` folder and link to them from CLAUDE.md
- **Keep focused**: Critical context, architectural decisions, and workflow instructions only
- **User approval required**: ALWAYS ask user permission before splitting CLAUDE.md files

## Pre-Commit Screenshots

**Before Every Commit - Screenshots**:
- **Run screenshot tool to update UI screenshots in documentation**
  - Run `cd services/webui && npm run screenshots` to capture current UI state
  - This automatically removes old screenshots and captures fresh ones
  - Commit updated screenshots with relevant feature/documentation changes
