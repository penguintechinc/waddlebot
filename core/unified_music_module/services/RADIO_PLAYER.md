# RadioPlayer Service

Complete single-stream radio playback service for WaddleBot with support for multiple radio providers.

## Overview

The `RadioPlayer` service manages streaming radio playback, differing from the traditional music player by eliminating queues. Instead, it focuses on:

- **One active station per community** - Only a single radio stream can play at a time
- **Stream switching** - Instantly switch between different radio stations
- **Metadata fetching** - Automatically retrieves now-playing information
- **Browser source integration** - Sends updates to OBS overlays via WebSocket
- **Multi-provider support** - Supports Pretzel, Epidemic Sound, StreamBeats, Monstercat, and Icecast

## Supported Providers

| Provider | Auth Method | Metadata Source | Notes |
|----------|------------|-----------------|-------|
| **Pretzel** | API Key + OAuth | REST API | Music licensing included |
| **Epidemic Sound** | API Key | REST API | Per-stream configuration |
| **StreamBeats** | API Key | REST API | YouTube Music alternative |
| **Monstercat** | API Key | REST API | Royalty-free music catalog |
| **Icecast** | None (open) | HTTP Metadata Tags | Direct stream URLs |

## Installation

### Add to Requirements

```bash
# Already included in /core/unified_music_module/requirements.txt
httpx>=0.25.0  # Async HTTP client
```

### Import

```python
from services.radio_player import RadioPlayer, create_radio_player
from services.radio_player import RadioStation, StationConfig, NowPlayingInfo
```

## Quick Start

### Initialize RadioPlayer

```python
import asyncio
from services.radio_player import create_radio_player

# Create instance (with optional database session)
player = create_radio_player(db_session=db)

# Initialize on startup
await player.initialize()

# At shutdown
await player.shutdown()
```

### Play a Station

```python
# Start playing a station
success = await player.play_station(
    community_id=12345,
    station_name="lofi-beats"
)

if success:
    print("Station started")
else:
    print("Failed to start station")
```

### Get Current Station Info

```python
# Get playing station and metadata
station = await player.get_current_station(community_id=12345)

if station:
    print(f"Playing: {station['station_name']}")
    print(f"Artist: {station['now_playing']['artist']}")
    print(f"Title: {station['now_playing']['title']}")
```

### Stop Playback

```python
# Stop current station
success = await player.stop_station(community_id=12345)
```

## API Reference

### Core Methods

#### `play_station(community_id, station_name) -> bool`

Start playing a radio station for a community.

**Parameters:**
- `community_id` (int): ID of the community/channel
- `station_name` (str): Name of the station to play

**Returns:**
- `bool`: True if playback started successfully

**Process:**
1. Loads station configuration from database
2. Validates stream URL accessibility
3. Creates appropriate metadata provider
4. Updates database radio state
5. Fetches initial metadata
6. Starts background metadata refresh task

**Example:**
```python
success = await player.play_station(12345, "pretzel-royalty-free")
```

---

#### `stop_station(community_id) -> bool`

Stop playing current station for a community.

**Parameters:**
- `community_id` (int): ID of the community

**Returns:**
- `bool`: True if stopped (or already stopped)

**Effects:**
- Cancels metadata refresh task
- Clears active station from memory
- Updates database to 'music' mode
- Removes cached metadata

**Example:**
```python
await player.stop_station(12345)
```

---

#### `get_current_station(community_id) -> Optional[Dict]`

Get information about currently playing station.

**Parameters:**
- `community_id` (int): ID of the community

**Returns:**
- Dict with keys:
  - `station_name` (str): Name of station
  - `provider` (str): Provider name
  - `stream_url` (str): Stream URL
  - `now_playing` (dict): Current track metadata
  - `started_at` (str): ISO timestamp when playback started
- `None`: If no station is playing

**Example:**
```python
station = await player.get_current_station(12345)
if station:
    print(f"Now Playing: {station['now_playing']['title']}")
```

---

#### `get_now_playing(community_id, use_cache=True) -> Optional[NowPlayingInfo]`

Get current now-playing metadata with caching.

**Parameters:**
- `community_id` (int): ID of the community
- `use_cache` (bool): Use cached metadata if available (default: True)

**Returns:**
- `NowPlayingInfo` object with:
  - `title`: Track title
  - `artist`: Artist name
  - `album`: Album name
  - `duration_seconds`: Track length
  - `bitrate`: Stream bitrate
  - `codec`: Audio codec
  - `genre`: Music genre
  - `thumbnail_url`: Album art URL
  - `updated_at`: ISO timestamp
- `None`: If metadata unavailable

**Caching:**
- Default TTL: 30 seconds
- Fetch fresh if cache expired or `use_cache=False`

**Example:**
```python
now_playing = await player.get_now_playing(12345)
if now_playing:
    print(f"{now_playing.artist} - {now_playing.title}")
```

---

#### `get_station_config(community_id, station_name) -> Optional[StationConfig]`

Load station configuration from database.

**Parameters:**
- `community_id` (int): ID of the community
- `station_name` (str): Name of station

**Returns:**
- `StationConfig` object with provider settings
- `None`: If not found

**Example:**
```python
config = await player.get_station_config(12345, "lofi-beats")
print(f"Stream URL: {config.stream_url}")
print(f"API Key: {config.api_key}")
```

---

#### `save_station_config(community_id, config) -> bool`

Save station configuration to database.

**Parameters:**
- `community_id` (int): ID of the community
- `config` (StationConfig): Configuration to save

**Returns:**
- `bool`: True if saved successfully

**Example:**
```python
config = StationConfig(
    provider="pretzel",
    name="lofi-beats",
    stream_url="https://stream.pretzel.rocks/lofi",
    api_key="your-key",
    api_endpoint="https://api.pretzel.rocks"
)
success = await player.save_station_config(12345, config)
```

---

#### `send_overlay_update(community_id, websocket_handler=None) -> bool`

Send now-playing metadata to browser source overlay.

**Parameters:**
- `community_id` (int): ID of the community
- `websocket_handler` (callable): Async function to send WebSocket message
  - Signature: `async def handler(community_id: int, message: dict)`

**Returns:**
- `bool`: True if sent successfully

**Message Format:**
```json
{
  "type": "radio_update",
  "community_id": 12345,
  "station": "lofi-beats",
  "provider": "pretzel",
  "now_playing": {
    "title": "Lo-Fi Hip Hop",
    "artist": "Various",
    "album": "Beats to Study To",
    "updated_at": "2025-12-16T15:30:00"
  },
  "timestamp": "2025-12-16T15:30:00"
}
```

**Example:**
```python
async def ws_handler(community_id, message):
    # Send to WebSocket connections
    for ws in connections[community_id]:
        await ws.send(json.dumps(message))

success = await player.send_overlay_update(12345, ws_handler)
```

---

#### `get_active_stations() -> Dict[int, Dict]`

Get all active stations across all communities.

**Returns:**
- Dict mapping `community_id` to station info
- Format: Same as `get_current_station()`

**Example:**
```python
active = await player.get_active_stations()
for community_id, station in active.items():
    print(f"Community {community_id}: {station['station_name']}")
```

---

### Initialization & Lifecycle

#### `initialize() -> None`

Initialize RadioPlayer on startup.

**Actions:**
- Loads active stations from database
- Restores playback state for each community
- Starts metadata refresh tasks

**Must be called during app startup:**
```python
@app.before_serving
async def startup():
    global player
    player = create_radio_player(db_session=dal)
    await player.initialize()
```

---

#### `shutdown() -> None`

Clean shutdown of RadioPlayer.

**Actions:**
- Cancels all metadata refresh tasks
- Clears active stations from memory
- Properly closes HTTP connections

**Must be called during app shutdown:**
```python
@app.after_serving
async def shutdown():
    await player.shutdown()
```

## Data Classes

### `StationConfig`

Configuration for a radio station.

```python
@dataclass
class StationConfig:
    provider: str                          # Radio provider name
    name: str                              # Station name
    stream_url: str                        # Direct stream URL
    api_endpoint: Optional[str] = None     # API endpoint for metadata
    api_key: Optional[str] = None          # API key for auth
    metadata_path: Optional[str] = None    # Custom metadata path
    bitrate: Optional[int] = None          # Stream bitrate (kbps)
    codec: Optional[str] = None            # Audio codec (mp3, aac, etc)
    custom_headers: Dict[str, str] = None  # Custom HTTP headers
```

### `NowPlayingInfo`

Current track metadata from stream.

```python
@dataclass
class NowPlayingInfo:
    title: Optional[str] = None            # Track title
    artist: Optional[str] = None           # Artist name
    album: Optional[str] = None            # Album name
    duration_seconds: Optional[int] = None # Track duration
    bitrate: Optional[int] = None          # Stream bitrate
    codec: Optional[str] = None            # Audio codec
    genre: Optional[str] = None            # Music genre
    thumbnail_url: Optional[str] = None    # Album art URL
    updated_at: Optional[str] = None       # ISO timestamp
```

### `RadioStation` (Enum)

Supported radio providers.

```python
class RadioStation(str, Enum):
    PRETZEL = "pretzel"
    EPIDEMIC = "epidemic"
    STREAMBEATS = "streambeats"
    MONSTERCAT = "monstercat"
    ICECAST = "icecast"
```

## Metadata Providers

### Icecast Metadata Fetcher

**Automatic:** Works with any Icecast-compatible stream.

**Features:**
- Reads ICY-MetaData headers
- Extracts StreamTitle tags
- Parses "Artist - Title" format

**Example Stream URLs:**
```
http://icecast.org:8000/live
https://radio.example.com:8443/stream.mp3
```

---

### Pretzel API Provider

**Setup Required:**
- Get API key from Pretzel
- Provide API endpoint URL

**Configuration:**
```python
config = StationConfig(
    provider="pretzel",
    name="my-station",
    stream_url="https://stream.pretzel.rocks/...",
    api_endpoint="https://api.pretzel.rocks/v1",
    api_key="your-api-key"
)
```

**Metadata Fetched:**
- Track name
- Artist
- Album
- Album art

---

### Epidemic Sound Provider

**Setup Required:**
- Get API key from Epidemic Sound
- Create stream/station

**Configuration:**
```python
config = StationConfig(
    provider="epidemic",
    name="my-epidemic-station",
    stream_url="https://stream.epidemicsound.com/...",
    api_key="your-api-key",
    metadata_path="stream-id"  # Optional: station ID
)
```

---

### Monstercat Provider

**Setup Required:**
- Get API key from Monstercat
- Subscribe to Gold or higher

**Configuration:**
```python
config = StationConfig(
    provider="monstercat",
    name="monstercat-playlist",
    stream_url="https://stream.monstercat.com/...",
    api_key="your-api-key"
)
```

**Metadata Fetched:**
- Track title
- Artist
- Album
- Genre
- Cover art

---

### StreamBeats Provider

**Setup Required:**
- Get API key from StreamBeats
- Active subscription

**Configuration:**
```python
config = StationConfig(
    provider="streambeats",
    name="streambeats-royalty-free",
    stream_url="https://stream.streambeats.com/...",
    api_key="your-api-key"
)
```

## Database Integration

### Tables Used

**music_provider_config** - Stores station configurations
```sql
- community_id: Owner community
- provider_type: Provider name
- is_enabled: Whether enabled
- oauth_access_token: Auth token (encrypted)
- config: JSON configuration (includes stream_url, api_key, etc)
```

**music_radio_state** - Tracks current playback state
```sql
- community_id: Owner community
- mode: 'music' or 'radio'
- current_station_url: Currently playing stream URL
- current_station_name: Station name
- stream_metadata: JSON with bitrate, codec, etc
- started_at: When playback started
- updated_at: Last update timestamp
```

### Querying Stations

Load active stations on startup:
```python
await player.initialize()  # Auto-loads from music_radio_state
```

## Error Handling

The RadioPlayer includes robust error handling:

```python
try:
    success = await player.play_station(community_id, "station-name")
    if not success:
        print("Station playback failed - check logs")
except Exception as e:
    print(f"Error: {e}")
```

**Common Error Causes:**
- Stream URL unreachable (network/firewall)
- Invalid API credentials
- Provider API rate limits
- Database connection issues

**Logging:**
All errors are logged with context via the `logger` instance.

## Integration with Browser Source

### Sending Updates to OBS

```python
# WebSocket handler for connected OBS overlays
async def send_to_overlay(community_id, message):
    # Get WebSocket connections for this community
    for ws in connected_clients[community_id]:
        try:
            await ws.send(json.dumps(message))
        except:
            pass

# Update overlay when metadata changes
await player.send_overlay_update(
    community_id=12345,
    websocket_handler=send_to_overlay
)
```

### Browser Source HTML Template

```html
<div id="radio-player">
  <div class="station-name" id="stationName">--</div>
  <div class="now-playing">
    <img id="albumArt" src="" alt="">
    <div class="track-info">
      <div class="artist" id="artist">--</div>
      <div class="title" id="title">--</div>
    </div>
  </div>
</div>

<script>
const ws = new WebSocket('ws://localhost/api/overlay');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'radio_update') {
    const np = msg.now_playing;
    document.getElementById('stationName').textContent = msg.station;
    document.getElementById('artist').textContent = np.artist || '--';
    document.getElementById('title').textContent = np.title || '--';
    if (np.thumbnail_url) {
      document.getElementById('albumArt').src = np.thumbnail_url;
    }
  }
};
</script>
```

## Performance Considerations

### Metadata Caching

- Default TTL: 30 seconds
- Reduces API calls to provider
- Use `use_cache=False` to force refresh

### Connection Pooling

HTTP connections are reused via httpx.AsyncClient. For best performance:

```python
# Share HTTP client across services
import httpx
http_client = httpx.AsyncClient()

player1 = create_radio_player(db_session=db, http_client=http_client)
player2 = create_radio_player(db_session=db, http_client=http_client)

# Close when done
await http_client.aclose()
```

### Background Tasks

Metadata refresh runs in background (`asyncio.Task`):
- Non-blocking to main event loop
- Automatically cancelled on `stop_station()`
- Graceful cleanup on `shutdown()`

## Examples

### Complete Example: Multi-Station Community

```python
import asyncio
from services.radio_player import create_radio_player, StationConfig

async def main():
    # Initialize
    player = create_radio_player(db_session=database)
    await player.initialize()

    try:
        # Configure stations
        pretzel_config = StationConfig(
            provider="pretzel",
            name="pretzel-royalty-free",
            stream_url="https://stream.pretzel.rocks/",
            api_endpoint="https://api.pretzel.rocks/v1",
            api_key="pretzel-key"
        )

        epidemic_config = StationConfig(
            provider="epidemic",
            name="epidemic-music",
            stream_url="https://stream.epidemicsound.com/",
            api_key="epidemic-key",
            metadata_path="my-stream"
        )

        # Save configurations
        await player.save_station_config(12345, pretzel_config)
        await player.save_station_config(12345, epidemic_config)

        # Play first station
        print("Playing Pretzel...")
        await player.play_station(12345, "pretzel-royalty-free")

        # Get metadata
        for i in range(5):
            await asyncio.sleep(30)
            now_playing = await player.get_now_playing(12345)
            if now_playing:
                print(f"Now: {now_playing.artist} - {now_playing.title}")

        # Switch stations
        print("\nSwitching to Epidemic...")
        await player.stop_station(12345)
        await player.play_station(12345, "epidemic-music")

        # Get active stations
        active = await player.get_active_stations()
        print(f"Active stations: {active}")

    finally:
        await player.shutdown()

if __name__ == "__main__":
    asyncio.run(main())
```

## Testing

Create test file at `/core/unified_music_module/services/test_radio_player.py`:

```python
import asyncio
import pytest
from radio_player import create_radio_player, StationConfig, RadioStation

@pytest.mark.asyncio
async def test_play_station():
    player = create_radio_player(db_session=None)
    config = StationConfig(
        provider="icecast",
        name="test-station",
        stream_url="http://icecast.example.com/stream"
    )
    # Test implementation...

@pytest.mark.asyncio
async def test_metadata_fetching():
    player = create_radio_player()
    # Test implementation...
```

## Troubleshooting

### Station Won't Start
- Check stream URL is valid: `curl -I <stream_url>`
- Verify API credentials if using paid provider
- Check firewall/network access

### No Metadata Fetched
- Ensure metadata endpoint is correct
- Check API key is valid
- Review provider documentation
- Icecast streams must support ICY metadata

### High Latency
- Reduce metadata polling (increase TTL)
- Check network connection to provider
- Verify database performance

### Memory Leaks
- Ensure `shutdown()` is called on exit
- Check no tasks remain after stop
- Monitor with: `await player.get_active_stations()`

## License

Part of WaddleBot. See main LICENSE file.
