# ModeController - Quick Start Guide

## Installation & Import

```python
from services import ModeController, PlayMode, create_mode_controller
```

## Basic Setup

```python
# Create mode controller with player services
mode_controller = create_mode_controller(
    music_player=music_player,
    radio_player=radio_player,
    browser_source_url="http://browser-source:8050"
)

# Initialize on startup
await mode_controller.initialize()

# Shutdown on graceful shutdown
await mode_controller.shutdown()
```

## Core API (5 Main Methods)

### 1. Switch to Music Mode
```python
success = await mode_controller.switch_to_music(community_id)
# Stops radio, activates music playback
# Returns: True if successful, False otherwise
```

### 2. Switch to Radio Mode
```python
success = await mode_controller.switch_to_radio(community_id)
# Pauses music, activates radio playback
# Returns: True if successful, False otherwise
```

### 3. Get Active Mode
```python
mode = await mode_controller.get_active_mode(community_id)
# Returns: "music", "radio", or None
```

### 4. Stop Playback
```python
success = await mode_controller.stop_current_mode(community_id)
# Stops all playback, clears mode state
# Returns: True if something was stopped, False otherwise
```

### 5. Resume Paused Music
```python
success = await mode_controller.resume_music_if_paused(community_id)
# Resumes music if it was paused during mode switch
# Returns: True if resumed or already playing, False otherwise
```

## FastAPI Route Example

```python
from fastapi import FastAPI, HTTPException

@app.post("/communities/{community_id}/music")
async def activate_music(community_id: int):
    success = await mode_controller.switch_to_music(community_id)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to switch to music")
    return {"mode": "music"}

@app.post("/communities/{community_id}/radio")
async def activate_radio(community_id: int):
    success = await mode_controller.switch_to_radio(community_id)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to switch to radio")
    return {"mode": "radio"}

@app.get("/communities/{community_id}/mode")
async def get_mode(community_id: int):
    mode = await mode_controller.get_active_mode(community_id)
    return {"mode": mode}

@app.post("/communities/{community_id}/stop")
async def stop_playback(community_id: int):
    await mode_controller.stop_current_mode(community_id)
    return {"mode": None}
```

## Common Patterns

### Pattern: User Requests Music
```python
# Stop radio and start music
current_mode = await mode_controller.get_active_mode(community_id)
if current_mode == "radio":
    await mode_controller.switch_to_music(community_id)
    await mode_controller.resume_music_if_paused(community_id)
elif current_mode is None:
    await mode_controller.switch_to_music(community_id)
    # Then play first track from queue...
```

### Pattern: User Requests Radio
```python
# Pause music and start radio
current_mode = await mode_controller.get_active_mode(community_id)
if current_mode == "music":
    await mode_controller.switch_to_radio(community_id)
elif current_mode is None:
    await mode_controller.switch_to_radio(community_id)

# Then play requested station
await radio_player.play_station(community_id, station_name)
```

### Pattern: Monitor All Communities
```python
# Get status of all active modes
all_states = await mode_controller.get_all_mode_states()
for community_id, state in all_states.items():
    print(f"Community {community_id}: {state.active_mode.value}")
```

## State Objects

### ModeState
```python
state = await mode_controller.get_mode_state(community_id)

# Access properties
print(state.community_id)                    # int
print(state.active_mode)                    # PlayMode enum
print(state.active_mode.value)              # "music" | "radio" | "none"
print(state.previous_mode)                  # PlayMode enum or None
print(state.music_paused_on_switch)         # bool
print(state.radio_paused_on_switch)         # bool
print(state.switched_at)                    # ISO timestamp string
print(state.last_updated)                   # ISO timestamp string

# Convert to dict for JSON/DB
state_dict = state.to_dict()
```

### PlayMode Enum
```python
from services import PlayMode

PlayMode.MUSIC   # "music"
PlayMode.RADIO   # "radio"
PlayMode.NONE    # "none"
```

## Configuration

### Browser Source URL
```python
# Via environment variable (preferred)
export BROWSER_SOURCE_URL=http://browser-source:8050

# Or via parameter
mode_controller = create_mode_controller(
    music_player=music_player,
    radio_player=radio_player,
    browser_source_url="http://custom-host:8050",
    http_timeout=10.0  # seconds
)
```

## Browser Source Notifications

The ModeController sends HTTP POST notifications when mode changes:

```
POST http://browser-source:8050/api/v1/internal/mode-change

{
    "community_id": 12345,
    "type": "mode_change",
    "timestamp": "2025-12-16T10:30:45.123456",
    "new_mode": "music",
    "previous_mode": "radio"
}
```

## Error Handling

```python
# All methods return False on failure and log errors
success = await mode_controller.switch_to_music(community_id)
if not success:
    logger.error(f"Failed to switch to music mode")

# Or check mode wasn't set
current = await mode_controller.get_active_mode(community_id)
if current != "music":
    logger.error("Music mode was not activated")
```

## Logging

Enable debug logging to see all operations:

```python
import logging
logging.getLogger("services.mode_controller").setLevel(logging.DEBUG)
```

## Advanced: Full Startup/Shutdown

```python
async def startup():
    global mode_controller

    # Create player services
    music_player = MusicPlayer(
        providers={...},
        queue=unified_queue,
        browser_source_url="http://browser-source:8050"
    )
    radio_player = RadioPlayer(db_session=db)

    # Initialize players
    await music_player.initialize()
    await radio_player.initialize()

    # Create and initialize mode controller
    mode_controller = create_mode_controller(
        music_player=music_player,
        radio_player=radio_player,
        browser_source_url="http://browser-source:8050"
    )
    await mode_controller.initialize()

async def shutdown():
    await mode_controller.shutdown()
    await radio_player.shutdown()
    await music_player.shutdown()
```

## Testing

Run the example file:
```bash
cd /home/penguin/code/WaddleBot/core/unified_music_module/services/
python example_mode_controller_usage.py
```

## File Locations

- Main Implementation: `/home/penguin/code/WaddleBot/core/unified_music_module/services/mode_controller.py`
- Full Documentation: `/home/penguin/code/WaddleBot/core/unified_music_module/services/MODE-CONTROLLER-README.md`
- Examples: `/home/penguin/code/WaddleBot/core/unified_music_module/services/example_mode_controller_usage.py`

## Key Points

- Only one mode active per community
- Mode switches are atomic (locked)
- Pause state is preserved when switching
- Browser source gets notified of mode changes
- All operations are async/await
- Comprehensive error handling and logging
- Type hints throughout
- Production ready

## Next Steps

1. Import the service: `from services import create_mode_controller`
2. Create instance during app startup
3. Use in route handlers or command processors
4. Monitor with `get_all_mode_states()`
5. Clean up during shutdown

See `MODE-CONTROLLER-README.md` for comprehensive documentation.
