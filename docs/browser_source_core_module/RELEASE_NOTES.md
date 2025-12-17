# Browser Source Core Module - Release Notes

## Version 2.0.0 (Current)

**Release Date**: 2025-01-15

### New Features
- **Unified Overlay System**: Single URL for all browser sources
- **WebSocket Caption Streaming**: Real-time caption delivery to OBS
- **gRPC API**: Service-to-service communication protocol
- **Key Rotation**: Graceful key rotation with 5-minute grace period
- **Access Logging**: Detailed overlay access analytics
- **Caption History**: Last 10 captions sent on WebSocket connect
- **Multi-Source Support**: Ticker, media, general, and caption sources

### Breaking Changes
- Overlay URL format changed
- WebSocket protocol added
- Database schema updated
- Python 3.9+ required

### Improvements
- Async WebSocket handling
- Better error recovery
- Access logging for security auditing
- Optimized database queries

### Bug Fixes
- Fixed WebSocket connection cleanup
- Fixed overlay key validation race condition
- Fixed caption broadcast to disconnected clients
- Fixed memory leak in connection registry

---

## Version 1.5.0

**Release Date**: 2024-11-20

### Features
- Caption overlay support
- Basic WebSocket implementation
- Theme configuration

---

## Version 1.0.0

**Release Date**: 2024-08-01

### Features
- Initial release
- Basic overlay rendering
- Token-based authentication
