# Spotify Provider Quick Reference

## File Location
```
/home/penguin/code/WaddleBot/core/unified_music_module/providers/spotify_provider.py
```

## Setup

```bash
# Environment variables
export SPOTIFY_CLIENT_ID="your_client_id"
export SPOTIFY_CLIENT_SECRET="your_client_secret"
export SPOTIFY_REDIRECT_URI="http://localhost:8888/callback"

# Install dependencies
pip install httpx>=0.25.0
```

## Basic Usage

```python
from providers import SpotifyProvider

# Initialize
spotify = SpotifyProvider()

# Get auth URL (send user here)
auth_url = spotify.get_auth_url(state="random_state")

# After user authorizes and returns with code
await spotify.authenticate({"code": "authorization_code"})

# Search
tracks = await spotify.search("Never Gonna Give You Up", limit=5)

# Play
await spotify.play(tracks[0].track_id)

# Pause
await spotify.pause()

# Resume
await spotify.resume()

# Skip
await spotify.skip()

# Get current track
now_playing = await spotify.get_now_playing()

# Cleanup
await spotify.close()
```

## URL Parsing

```python
url = "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"
track_id = SpotifyProvider.parse_track_url(url)
# Returns: "3n3Ppam7vgaVa1iaRUc9Lp"
```

## Device Management

```python
# List devices
devices = await spotify.get_devices()

# Set active device
await spotify.set_device(devices[0]['id'])
```

## Playlists

```python
# Get playlists
playlists = await spotify.get_playlists(limit=20)

# Get playlist tracks
tracks = await spotify.get_playlist_tracks(playlist_id, limit=50)
```

## Advanced Features

```python
# Add to queue
await spotify.add_to_queue(track_id)

# Set volume (0-100)
await spotify.set_volume(75)

# Seek to position (milliseconds)
await spotify.seek(60000)  # Seek to 1 minute

# Get full playback state
state = await spotify.get_playback_state()
```

## Error Handling

```python
from providers import SpotifyAuthError, SpotifyAPIError

try:
    await spotify.play("track_id")
except SpotifyAuthError as e:
    print(f"Auth error: {e}")
except SpotifyAPIError as e:
    print(f"API error: {e}")
```

## Methods Reference

### Base Interface
- `search(query, limit=10)` - Search tracks
- `get_track(track_id)` - Get track info
- `play(track_id)` - Play track
- `pause()` - Pause playback
- `resume()` - Resume playback
- `skip()` - Skip to next
- `get_now_playing()` - Current track
- `is_authenticated()` - Check auth
- `authenticate(credentials)` - Authenticate
- `health_check()` - Service health

### Spotify-Specific
- `get_devices()` - List devices
- `set_device(device_id)` - Set device
- `get_playlists(limit)` - User playlists
- `get_playlist_tracks(playlist_id, limit)` - Playlist tracks
- `add_to_queue(track_id)` - Add to queue
- `get_playback_state()` - Playback state
- `set_volume(volume_percent)` - Set volume
- `seek(position_ms)` - Seek position

### Authentication
- `get_auth_url(state)` - OAuth URL
- `exchange_code(code)` - Exchange code
- `refresh_access_token()` - Refresh token

### Utilities
- `parse_track_url(url)` - Extract track ID (static)
- `close()` - Close HTTP client

## Key Features

- OAuth2 authorization code flow
- Automatic token refresh (5 min before expiry)
- URL/URI parsing for track IDs
- Device-specific playback control
- Comprehensive error handling
- Full async/await support
- Logging throughout
- Type hints everywhere

## Documentation

- `SPOTIFY_USAGE.md` - Comprehensive usage guide
- `README_SPOTIFY.md` - Technical documentation
- `test_spotify_provider.py` - Example tests
