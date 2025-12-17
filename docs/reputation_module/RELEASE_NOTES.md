# Reputation Module - Release Notes

## Version 2.0.0 (Current)

**Release Date**: 2025-01-15

### New Features
- FICO-style reputation system (300-850 range)
- Global cross-community reputation
- Premium weight customization
- Auto-ban policy enforcement
- At-risk user detection
- gRPC API for high-throughput event processing
- Batch event processing (up to 1000 events)
- Comprehensive leaderboards (community + global)

### Event Types Supported
- Chat messages, follows, subscriptions (tier 1-3)
- Gift subs, donations, cheers, raids, boosts
- Moderation actions (warn, timeout, kick, ban)
- Giveaway entries, command usage

### Breaking Changes
- API endpoints restructured (/api/v1/)
- Database schema updated
- Python 3.9+ required
- gRPC port 50021 required

### Performance
- Weight caching (TTL: 5 min)
- Batch processing support
- Database query optimization
- Connection pooling

---

## Version 1.0.0

**Release Date**: 2024-10-01

### Features
- Initial release
- Basic reputation tracking
- Simple event processing
