# RadioPlayer - Quick Start Guide

Fast reference for the RadioPlayer service.

## Import

```python
from services.radio_player import (
    RadioPlayer,
    create_radio_player,
    RadioStation,
    StationConfig,
    NowPlayingInfo,
)
```

## Basic Setup

```python
# Create instance
player = create_radio_player(db_session=database)

# On startup
await player.initialize()

# On shutdown
await player.shutdown()
```

## Core Operations

### Play a Station
```python
success = await player.play_station(community_id=123, station_name="my-station")
```

### Stop Playback
```python
await player.stop_station(community_id=123)
```

### Get Current Station
```python
station = await player.get_current_station(community_id=123)
# Returns: {station_name, provider, stream_url, now_playing, started_at}
```

### Get Now-Playing Info
```python
now_playing = await player.get_now_playing(community_id=123)
# Returns: NowPlayingInfo with title, artist, album, etc.
```

### Get All Active Stations
```python
active = await player.get_active_stations()
# Returns: Dict[community_id -> station_info]
```

## Configuration

### Save Station Config
```python
config = StationConfig(
    provider="pretzel",           # or: epidemic, streambeats, monstercat, icecast
    name="my-station",
    stream_url="https://...",
    api_key="...",                # Optional, depends on provider
    api_endpoint="https://...",   # Optional
)
await player.save_station_config(community_id=123, config=config)
```

### Load Station Config
```python
config = await player.get_station_config(
    community_id=123,
    station_name="my-station"
)
```

## Provider Setup

### Icecast (Free, Self-Hosted)
```python
config = StationConfig(
    provider="icecast",
    name="my-icecast",
    stream_url="http://icecast.example.com:8000/stream",
)
```

### Pretzel (Music Licensing)
```python
config = StationConfig(
    provider="pretzel",
    name="pretzel-royalty-free",
    stream_url="https://stream.pretzel.rocks/...",
    api_endpoint="https://api.pretzel.rocks/v1",
    api_key="your-pretzel-key",
)
```

### Epidemic Sound
```python
config = StationConfig(
    provider="epidemic",
    name="epidemic-station",
    stream_url="https://stream.epidemicsound.com/...",
    api_key="your-epidemic-key",
    metadata_path="stream-id",  # Optional
)
```

### Monstercat
```python
config = StationConfig(
    provider="monstercat",
    name="monstercat-gold",
    stream_url="https://stream.monstercat.com/...",
    api_key="your-monstercat-key",
)
```

### StreamBeats
```python
config = StationConfig(
    provider="streambeats",
    name="streambeats-royalty-free",
    stream_url="https://stream.streambeats.com/...",
    api_key="your-streambeats-key",
)
```

## Browser Overlay Integration

### Send Updates to OBS

```python
async def ws_handler(community_id, message):
    """Send message to WebSocket clients"""
    for ws in overlay_connections[community_id]:
        await ws.send(json.dumps(message))

await player.send_overlay_update(
    community_id=123,
    websocket_handler=ws_handler
)
```

**Message Format:**
```json
{
  "type": "radio_update",
  "community_id": 123,
  "station": "my-station",
  "provider": "pretzel",
  "now_playing": {
    "title": "Track Name",
    "artist": "Artist Name",
    "album": "Album",
    "updated_at": "2025-12-16T15:30:00"
  },
  "timestamp": "2025-12-16T15:30:00"
}
```

## Common Patterns

### Rotate Between Stations
```python
stations = ["station-1", "station-2", "station-3"]

for station_name in stations:
    await player.stop_station(123)
    await player.play_station(123, station_name)
    await asyncio.sleep(300)  # 5 minutes each
```

### Monitor Now-Playing
```python
while True:
    np = await player.get_now_playing(123)
    if np:
        print(f"{np.artist} - {np.title}")
    await asyncio.sleep(30)  # Check every 30 seconds
```

### Handle Station Switch Failures
```python
async def safe_play(community_id, station_name):
    try:
        success = await player.play_station(community_id, station_name)
        if not success:
            logger.error(f"Failed to play {station_name}")
            await player.stop_station(community_id)
            return False
        return True
    except Exception as e:
        logger.error(f"Error: {e}")
        return False
```

## Data Classes Reference

### StationConfig
```python
@dataclass
class StationConfig:
    provider: str                          # Required
    name: str                              # Required
    stream_url: str                        # Required
    api_endpoint: Optional[str] = None
    api_key: Optional[str] = None
    metadata_path: Optional[str] = None
    bitrate: Optional[int] = None
    codec: Optional[str] = None
    custom_headers: Dict[str, str] = None
```

### NowPlayingInfo
```python
@dataclass
class NowPlayingInfo:
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    duration_seconds: Optional[int] = None
    bitrate: Optional[int] = None
    codec: Optional[str] = None
    genre: Optional[str] = None
    thumbnail_url: Optional[str] = None
    updated_at: Optional[str] = None
```

## Troubleshooting Checklist

- [ ] Stream URL is valid: `curl -I <stream_url>`
- [ ] API key is correct (if using paid provider)
- [ ] Network connectivity to provider
- [ ] Icecast streams have metadata enabled
- [ ] Database has music_provider_config table
- [ ] Database has music_radio_state table
- [ ] No active tasks remaining after shutdown
- [ ] Error logs checked in logger output

## Error Messages

| Error | Solution |
|-------|----------|
| "Stream validation failed" | Check URL, network access |
| "Station config not found" | Save config first with `save_station_config()` |
| "No metadata available" | Check API key, endpoint, provider status |
| "Database connection failed" | Ensure DB session is passed to constructor |
| "Task not cancelled properly" | Call `shutdown()` explicitly |

## Performance Tips

1. **Reuse HTTP client:**
   ```python
   http_client = httpx.AsyncClient()
   player = create_radio_player(db=db, http_client=http_client)
   ```

2. **Cache metadata:**
   ```python
   # Default 30-sec cache, set use_cache=True (default)
   await player.get_now_playing(123)  # Uses cache
   ```

3. **Batch operations:**
   ```python
   # Get all active stations at once
   active = await player.get_active_stations()
   ```

## See Also

- **Full Docs:** `RADIO_PLAYER.md`
- **Tests:** `test_radio_player.py`
- **Database:** `config/postgres/migrations/012_add_music_providers.sql`
