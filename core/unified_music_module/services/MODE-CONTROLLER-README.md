# ModeController Service

The ModeController service manages switching between Music Player and Radio Player modes in WaddleBot. It ensures only one mode is active per community at any time and coordinates graceful transitions between modes.

## Overview

The ModeController acts as an orchestrator between two playback systems:
- **MusicPlayer**: Queue-based playback with support for multiple providers (Spotify, YouTube, SoundCloud)
- **RadioPlayer**: Single-stream radio playback with support for multiple radio providers (Pretzel, Epidemic, Monstercat, StreamBeats, Icecast)

## Key Features

- **Exclusive Mode Activation**: Only one mode (music or radio) can be active per community
- **Graceful Mode Transitions**: Proper cleanup and state preservation when switching modes
- **State Tracking**: Maintains mode history and transition timestamps
- **Browser Source Integration**: Sends mode change notifications to overlay via HTTP
- **Thread-Safe Operations**: Uses asyncio locks for safe concurrent operations
- **Pause State Preservation**: Remembers pause states when switching modes

## Core Methods

### `switch_to_music(community_id: int) -> bool`

Activates Music Player mode for a community.

**Behavior:**
- If radio is playing: Stops radio and saves state
- If music was paused: Resumes playback
- Sends mode change notification to browser source

**Example:**
```python
success = await mode_controller.switch_to_music(community_id=12345)
if success:
    print("Switched to music mode")
```

### `switch_to_radio(community_id: int) -> bool`

Activates Radio Player mode for a community.

**Behavior:**
- If music is playing: Pauses music and saves state
- Switches to radio mode
- Sends mode change notification to browser source

**Example:**
```python
success = await mode_controller.switch_to_radio(community_id=12345)
if success:
    print("Switched to radio mode")
```

### `get_active_mode(community_id: int) -> Optional[str]`

Returns the currently active mode for a community.

**Returns:**
- `"music"`: Music Player is active
- `"radio"`: Radio Player is active
- `None`: No mode is currently active

**Example:**
```python
mode = await mode_controller.get_active_mode(community_id=12345)
if mode == "music":
    print("Music is playing")
elif mode == "radio":
    print("Radio is playing")
else:
    print("Nothing is playing")
```

### `stop_current_mode(community_id: int) -> bool`

Stops all playback and clears mode state.

**Behavior:**
- Stops current playback (music or radio)
- Sets active mode to None
- Resets pause state flags
- Sends mode change notification

**Example:**
```python
success = await mode_controller.stop_current_mode(community_id=12345)
if success:
    print("Playback stopped")
```

### `resume_music_if_paused(community_id: int) -> bool`

Resumes music if it was paused during a mode switch.

**Example:**
```python
# Switch to radio then back to music
await mode_controller.switch_to_radio(community_id)
await mode_controller.switch_to_music(community_id)
# Music will remain paused, resume it:
await mode_controller.resume_music_if_paused(community_id)
```

### `get_mode_state(community_id: int) -> Optional[ModeState]`

Returns the complete mode state for a community.

**Example:**
```python
state = await mode_controller.get_mode_state(community_id=12345)
if state:
    print(f"Mode: {state.active_mode.value}")
    print(f"Previous: {state.previous_mode.value if state.previous_mode else 'None'}")
    print(f"Switched at: {state.switched_at}")
```

### `get_all_mode_states() -> Dict[int, ModeState]`

Returns mode states for all communities.

**Example:**
```python
all_states = await mode_controller.get_all_mode_states()
for community_id, state in all_states.items():
    print(f"Community {community_id}: {state.active_mode.value}")
```

## Data Structures

### PlayMode Enum

```python
class PlayMode(str, Enum):
    MUSIC = "music"
    RADIO = "radio"
    NONE = "none"
```

### ModeState Dataclass

```python
@dataclass
class ModeState:
    community_id: int
    active_mode: PlayMode = PlayMode.NONE
    previous_mode: Optional[PlayMode] = None
    music_paused_on_switch: bool = False
    radio_paused_on_switch: bool = False
    switched_at: Optional[str] = None
    last_updated: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        ...
```

## Initialization

### Basic Setup

```python
from services.mode_controller import create_mode_controller
from services.music_player import MusicPlayer
from services.radio_player import RadioPlayer

# Create player instances
music_player = MusicPlayer(providers={...}, queue=queue)
radio_player = RadioPlayer(db_session=db)

# Create mode controller
mode_controller = create_mode_controller(
    music_player=music_player,
    radio_player=radio_player,
    browser_source_url="http://browser-source:8050"
)

# Initialize
await mode_controller.initialize()
```

### Startup Integration

```python
async def startup():
    # Initialize all services
    await music_player.initialize()
    await radio_player.initialize()
    await mode_controller.initialize()

async def shutdown():
    # Cleanup in reverse order
    await mode_controller.shutdown()
    await radio_player.shutdown()
    await music_player.shutdown()
```

## Browser Source Integration

The ModeController sends mode change notifications to the browser source overlay via HTTP POST:

### Endpoint
```
POST http://browser-source:8050/api/v1/internal/mode-change
```

### Payload Format
```json
{
    "community_id": 12345,
    "type": "mode_change",
    "timestamp": "2025-12-16T10:30:45.123456",
    "new_mode": "music",
    "previous_mode": "radio"
}
```

### Response
```json
{
    "status": "ok"
}
```

## Usage Patterns

### Pattern 1: User Requests Music Mode

```python
async def user_requests_music(community_id: int):
    """User requests to switch to music mode"""
    # Check if radio is playing
    current_mode = await mode_controller.get_active_mode(community_id)

    if current_mode == "radio":
        # Switch to music (radio will be stopped)
        success = await mode_controller.switch_to_music(community_id)
        if success:
            # If music was paused, resume it
            await mode_controller.resume_music_if_paused(community_id)
    elif current_mode is None:
        # No mode active, start music
        await mode_controller.switch_to_music(community_id)
        # Then play first track from queue...
```

### Pattern 2: User Requests Radio Mode

```python
async def user_requests_radio(community_id: int, station_name: str):
    """User requests to switch to radio mode"""
    # Check if music is playing
    current_mode = await mode_controller.get_active_mode(community_id)

    if current_mode == "music":
        # Switch to radio (music will be paused)
        success = await mode_controller.switch_to_radio(community_id)
        if not success:
            return False
    elif current_mode is None:
        # No mode active, start radio
        success = await mode_controller.switch_to_radio(community_id)
        if not success:
            return False

    # Now play the requested station
    station_success = await radio_player.play_station(community_id, station_name)
    return station_success
```

### Pattern 3: Stop All Playback

```python
async def stop_playback(community_id: int):
    """Stop all playback for a community"""
    await mode_controller.stop_current_mode(community_id)
    # Notify user
```

### Pattern 4: Monitor All Communities

```python
async def monitor_all_modes():
    """Monitor active modes across all communities"""
    states = await mode_controller.get_all_mode_states()

    for community_id, state in states.items():
        if state.active_mode == PlayMode.MUSIC:
            print(f"Community {community_id}: Music playing")
        elif state.active_mode == PlayMode.RADIO:
            print(f"Community {community_id}: Radio playing")
```

## Error Handling

The ModeController uses async/await and logs errors. Handle exceptions appropriately:

```python
try:
    success = await mode_controller.switch_to_music(community_id)
    if not success:
        logger.error(f"Failed to switch to music mode for community {community_id}")
except Exception as e:
    logger.error(f"Error during mode switch: {e}")
```

## Configuration

### Browser Source URL

Configure via environment variable or constructor:

```python
# Via environment variable
export BROWSER_SOURCE_URL=http://browser-source:8050

# Or via constructor
mode_controller = create_mode_controller(
    music_player=music_player,
    radio_player=radio_player,
    browser_source_url="http://custom-url:8050"
)
```

### HTTP Timeout

Configure timeout for browser source requests:

```python
mode_controller = create_mode_controller(
    music_player=music_player,
    radio_player=radio_player,
    http_timeout=10.0  # seconds
)
```

## State Persistence

The ModeController maintains in-memory state only. For persistence:

```python
# Get mode states before shutdown
all_states = await mode_controller.get_all_mode_states()

# Save to database
for community_id, state in all_states.items():
    await save_mode_state_to_db(community_id, state.to_dict())

# Load from database on startup
saved_states = await load_mode_states_from_db()
for community_id, state_dict in saved_states.items():
    # Mode state will be recreated on demand
    pass
```

## Thread Safety

The ModeController uses asyncio locks for safe concurrent operations per community:

```python
# These can be called concurrently for different communities without issues
await asyncio.gather(
    mode_controller.switch_to_music(123),
    mode_controller.switch_to_radio(456),
    mode_controller.switch_to_music(789),
)
```

However, for the same community, operations are serialized:

```python
# These will be processed sequentially for the same community
await mode_controller.switch_to_music(123)
await mode_controller.switch_to_radio(123)  # Waits for previous operation
```

## Logging

The ModeController logs at appropriate levels:

```
INFO  - Mode transitions
DEBUG - HTTP notifications to browser source
WARN  - Browser source communication issues
ERROR - Unexpected errors in mode switching
```

Enable debug logging to see all activity:

```python
import logging
logging.getLogger('services.mode_controller').setLevel(logging.DEBUG)
```

## Example Integration with FastAPI

```python
from fastapi import FastAPI, HTTPException

app = FastAPI()
mode_controller = None

@app.on_event("startup")
async def startup_event():
    global mode_controller
    # Initialize mode_controller...
    await mode_controller.initialize()

@app.on_event("shutdown")
async def shutdown_event():
    await mode_controller.shutdown()

@app.post("/communities/{community_id}/music")
async def activate_music_mode(community_id: int):
    success = await mode_controller.switch_to_music(community_id)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to switch to music mode")
    return {"status": "ok", "mode": "music"}

@app.post("/communities/{community_id}/radio")
async def activate_radio_mode(community_id: int):
    success = await mode_controller.switch_to_radio(community_id)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to switch to radio mode")
    return {"status": "ok", "mode": "radio"}

@app.get("/communities/{community_id}/mode")
async def get_mode(community_id: int):
    mode = await mode_controller.get_active_mode(community_id)
    return {"community_id": community_id, "mode": mode}

@app.post("/communities/{community_id}/stop")
async def stop_playback(community_id: int):
    await mode_controller.stop_current_mode(community_id)
    return {"status": "ok", "mode": None}
```

## Troubleshooting

### Mode Switch Fails

1. Check that both MusicPlayer and RadioPlayer are initialized
2. Verify browser source URL is accessible
3. Check logs for specific error messages
4. Ensure sufficient time between rapid mode switches

### Browser Source Not Receiving Notifications

1. Verify `BROWSER_SOURCE_URL` environment variable is set correctly
2. Check that browser source API is running and accessible
3. Look for HTTP timeout errors in logs
4. Verify network connectivity between services

### Mode State Not Updating

1. Check that ModeController is properly initialized
2. Verify asyncio event loop is running
3. Check for exceptions in logs
4. Ensure community_id is valid

## Testing

See `example_mode_controller_usage.py` for comprehensive examples:

```bash
cd /home/penguin/code/WaddleBot/core/unified_music_module/services/
python example_mode_controller_usage.py
```
