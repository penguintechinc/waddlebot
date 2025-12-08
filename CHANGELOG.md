# Changelog

All notable changes to WaddleBot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-12-08

### Added

#### Kubernetes & Deployment
- Complete Kubernetes deployment infrastructure with Helm v3 charts
- Raw Kubernetes manifests with Kustomize support
- MicroK8s and CNCF Kubernetes (kind, minikube) installation scripts
- GitHub Actions CI/CD automation for automatic deployment
- Setup scripts for GitHub Actions integration with K8s clusters
- Comprehensive K8s documentation (README, QUICKSTART, INSTALL, GITHUB_ACTIONS)
- 32 services deployed: 6 infrastructure, 8 core, 5 collectors, 9 interactive, 4 pushing modules

#### Health Checks & Monitoring
- Standardized Python-based health check script (`scripts/healthcheck.py`)
- No curl dependency - uses Python stdlib only
- Three standard endpoints for all modules:
  - `/health` - Basic health status
  - `/healthz` - Kubernetes liveness/readiness probe
  - `/metrics` - Prometheus-compatible metrics
- Comprehensive metrics: requests, CPU, memory, file descriptors, threads
- Updated 30 Dockerfiles with consistent health check pattern
- Health check documentation (`docs/healthcheck-standardization.md`)

#### Loyalty & Gamification System
- Complete virtual currency system with earning configurations
- Minigames: Slots, Coinflip, Roulette with configurable odds
- Player-vs-player duels with wager system and gear bonuses
- Giveaway system with reputation-based weighting
- Gear/equipment system with stat bonuses
- Leaderboards for currency, duels, and game stats
- Multi-platform support (Twitch, Discord, Slack, YouTube, Kick)

#### Documentation
- Comprehensive README.md with features, architecture, quick start
- Health check standardization guide
- Kubernetes deployment documentation
- GitHub Actions CI/CD setup guide
- Screenshot capture script adapted from Elder project

### Changed
- Bumped version from 0.1.0 to 0.2.0
- README completely rewritten with modern format and comprehensive information
- All Dockerfiles now use standardized health checks
- Improved service dependency management in loyalty module
- Enhanced CI/CD workflow with Kubernetes deployment job

### Fixed
- Loyalty module service initialization order (EarningConfigService, DuelService dependencies)
- CRLF line endings in shell scripts
- Health check permissions in Docker containers (chmod 755)
- Dockerfile COPY paths for loyalty module

### Infrastructure
- GitHub Container Registry (GHCR) integration for CI/CD
- Service account with namespace-scoped permissions for K8s
- Automated image builds and pushes on main branch
- Helm-based deployments with configurable values
- Health check-based container orchestration

### Security
- API key authentication with RBAC
- Webhook signature verification (HMAC-SHA256)
- OAuth token management with automatic refresh
- Non-root containers with proper user permissions
- Database secrets via Kubernetes secrets
- Rate limiting at ingress level

## [0.1.0] - 2024-XX-XX

### Initial Release

#### Core Platform
- Multi-platform bot framework (Twitch, Discord, Slack, YouTube Live, Kick)
- Microservices architecture with Python 3.13
- Flask/Quart async web framework
- PostgreSQL database with AsyncDAL wrapper
- Redis session management
- MinIO object storage
- Docker and Docker Compose support

#### Modules
- **Trigger/Receiver**: Twitch (EventSub), Discord (py-cord), Slack, YouTube Live, Kick
- **Processing**: Router module with command routing and caching
- **Interactive**: AI, Alias, Shoutout, Inventory, Calendar, Memories, Music (YouTube/Spotify)
- **Core**: Identity, Labels, Browser Source, Reputation, Community, AI Researcher
- **Admin**: Hub module with React frontend

#### Features
- AI-powered interactions (Ollama, OpenAI, MCP)
- Cross-platform identity linking
- Event calendar with approval workflows
- Music integration with browser source output
- Inventory management system
- Community memory system (quotes, reminders, URLs)
- Platform-specific shoutouts with API integration
- Linux-style command alias system

#### Infrastructure
- PostgreSQL with read replica support
- Redis for caching and sessions
- MinIO for object storage
- Qdrant vector database for AI
- Ollama for local LLM inference
- Nginx reverse proxy configurations

---

[0.2.0]: https://github.com/waddlebot/waddlebot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/waddlebot/waddlebot/releases/tag/v0.1.0
