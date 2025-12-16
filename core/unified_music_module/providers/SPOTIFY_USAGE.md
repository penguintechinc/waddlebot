# Spotify Provider Usage Guide

This guide explains how to use the `SpotifyProvider` implementation.

## Configuration

Set the following environment variables:

```bash
export SPOTIFY_CLIENT_ID="your_client_id_here"
export SPOTIFY_CLIENT_SECRET="your_client_secret_here"
export SPOTIFY_REDIRECT_URI="http://localhost:8888/callback"
```

## Getting Spotify Credentials

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create a new app
3. Copy the Client ID and Client Secret
4. Add your redirect URI in the app settings

## Basic Usage

### Initialize the Provider

```python
from providers import SpotifyProvider

# Initialize (reads from environment variables)
spotify = SpotifyProvider()
```

### OAuth2 Authentication Flow

```python
# Step 1: Get authorization URL
auth_url = spotify.get_auth_url(state="random_state_string")
print(f"Please visit: {auth_url}")

# Step 2: User visits URL and authorizes, then is redirected to your redirect_uri
# with a 'code' parameter

# Step 3: Exchange the code for tokens
await spotify.authenticate({"code": "authorization_code_from_callback"})

# Alternative: Use existing tokens
await spotify.authenticate({
    "access_token": "your_access_token",
    "refresh_token": "your_refresh_token",
    "expires_in": 3600
})
```

### Search for Tracks

```python
# Search for tracks
tracks = await spotify.search("Never Gonna Give You Up", limit=5)

for track in tracks:
    print(f"{track.name} by {track.artist}")
    print(f"Album: {track.album}")
    print(f"Duration: {track.duration_ms}ms")
```

### Get Track by ID

```python
# Get a specific track
track = await spotify.get_track("3n3Ppam7vgaVa1iaRUc9Lp")
if track:
    print(f"Track: {track.name}")
```

### Parse Spotify URLs

```python
# Extract track ID from URL
url = "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abc123"
track_id = SpotifyProvider.parse_track_url(url)
print(f"Track ID: {track_id}")
```

### Playback Control

```python
# Play a track
success = await spotify.play("3n3Ppam7vgaVa1iaRUc9Lp")

# Pause playback
await spotify.pause()

# Resume playback
await spotify.resume()

# Skip to next track
await spotify.skip()

# Get currently playing track
now_playing = await spotify.get_now_playing()
if now_playing:
    print(f"Now playing: {now_playing.name}")
```

### Device Management

```python
# Get available devices
devices = await spotify.get_devices()
for device in devices:
    print(f"Device: {device['name']} ({device['type']})")
    print(f"  Active: {device['is_active']}")
    print(f"  ID: {device['id']}")

# Set active device
await spotify.set_device(devices[0]['id'])
```

### Playlist Operations

```python
# Get user's playlists
playlists = await spotify.get_playlists(limit=10)
for playlist in playlists:
    print(f"{playlist['name']} - {playlist['tracks']['total']} tracks")

# Get tracks from a playlist
playlist_id = playlists[0]['id']
tracks = await spotify.get_playlist_tracks(playlist_id, limit=50)
```

### Advanced Playback Features

```python
# Add track to queue
await spotify.add_to_queue("track_id_here")

# Set volume (0-100)
await spotify.set_volume(50)

# Seek to position (in milliseconds)
await spotify.seek(60000)  # Seek to 1 minute

# Get full playback state
state = await spotify.get_playback_state()
if state:
    print(f"Device: {state['device']['name']}")
    print(f"Playing: {state['is_playing']}")
    print(f"Progress: {state['progress_ms']}ms")
```

### Health Check

```python
# Check if authenticated and service is accessible
is_healthy = await spotify.health_check()
print(f"Service healthy: {is_healthy}")

# Check authentication status
is_authed = await spotify.is_authenticated()
print(f"Authenticated: {is_authed}")
```

### Cleanup

```python
# Close the HTTP client when done
await spotify.close()
```

## Complete Example

```python
import asyncio
from providers import SpotifyProvider

async def main():
    # Initialize provider
    spotify = SpotifyProvider()

    try:
        # Authenticate (you would get this code from OAuth callback)
        await spotify.authenticate({"code": "your_auth_code"})

        # Search for a song
        tracks = await spotify.search("Rick Astley Never Gonna Give You Up", limit=1)

        if tracks:
            track = tracks[0]
            print(f"Found: {track.name} by {track.artist}")

            # Play the track
            success = await spotify.play(track.track_id)
            if success:
                print("Playing track!")

                # Wait a bit
                await asyncio.sleep(10)

                # Pause
                await spotify.pause()
                print("Paused!")

    finally:
        # Always close the client
        await spotify.close()

if __name__ == "__main__":
    asyncio.run(main())
```

## Error Handling

The provider raises two main exception types:

- `SpotifyAuthError`: Authentication or token-related errors
- `SpotifyAPIError`: API request failures

```python
from providers import SpotifyAuthError, SpotifyAPIError

try:
    await spotify.play("invalid_track_id")
except SpotifyAuthError as e:
    print(f"Authentication error: {e}")
except SpotifyAPIError as e:
    print(f"API error: {e}")
```

## Token Management

The provider automatically handles token refresh:

- Tokens are refreshed automatically when they expire
- Refresh happens 5 minutes before expiration
- 401 responses trigger automatic token refresh and retry

## Scopes

The provider requests these OAuth scopes:

- `user-read-playback-state`: Read playback state
- `user-modify-playback-state`: Control playback
- `user-read-currently-playing`: Read currently playing track
- `playlist-read-private`: Read private playlists
- `playlist-read-collaborative`: Read collaborative playlists
- `user-library-read`: Read user's library

Add more scopes if you need additional functionality.
