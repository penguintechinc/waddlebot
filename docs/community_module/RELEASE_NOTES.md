# Community Module - Release Notes

## Version 2.0.0 (Current)

**Release Date**: 2025-01-15

### Features
- Core community management infrastructure
- Multi-platform support (Twitch, YouTube, Discord, Kick)
- Member role system (owner, admin, moderator, member)
- Community-scoped reputation integration
- Premium/free tier support
- Database schema for communities, members, and platforms

### Technical
- Quart async framework
- pyDAL ORM
- PostgreSQL database
- AAA logging integration
- Health check endpoints

### Database Schema
- `communities` table
- `community_members` table
- `community_platforms` table
- `community_settings` table (future)

### Roadmap
- Full REST API implementation
- Community creation/management endpoints
- Member management API
- Platform connection API
- Community analytics
- Settings management

---

## Version 1.0.0

**Release Date**: 2024-09-01

### Features
- Initial release
- Basic module structure
- Database integration
- Status endpoint
