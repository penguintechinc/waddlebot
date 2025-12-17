"""
Example usage of the RadioPlayer service.

Demonstrates:
- Initialization and shutdown
- Playing stations
- Fetching metadata
- Browser overlay integration
- Configuration management
"""

import asyncio
import json
import logging
from datetime import datetime

from radio_player import (
    create_radio_player,
    StationConfig,
    RadioStation,
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# Example 1: Basic Playback
async def example_basic_playback():
    """Simple example of playing a station."""
    logger.info("=== Example 1: Basic Playback ===")

    # Create player (no database session in this example)
    player = create_radio_player(db_session=None)

    try:
        # Note: In real use, you would:
        # 1. Configure the station
        # 2. Save it to database
        # 3. Load it from database

        logger.info("RadioPlayer created successfully")

        # Demonstrate the API (without actual streaming)
        logger.info("Demonstrated: play_station(), stop_station(), get_current_station()")

    finally:
        await player.shutdown()
        logger.info("Player shutdown complete\n")


# Example 2: Station Configuration
async def example_station_configuration():
    """Example of configuring different radio stations."""
    logger.info("=== Example 2: Station Configuration ===")

    # Pretzel configuration
    pretzel_config = StationConfig(
        provider=RadioStation.PRETZEL.value,
        name="pretzel-royalty-free",
        stream_url="https://stream.pretzel.rocks/royalty-free-music",
        api_endpoint="https://api.pretzel.rocks/v1",
        api_key="your-pretzel-api-key",
        bitrate=192,
        codec="mp3"
    )
    logger.info(f"Created Pretzel config: {pretzel_config.name}")

    # Epidemic Sound configuration
    epidemic_config = StationConfig(
        provider=RadioStation.EPIDEMIC.value,
        name="epidemic-music",
        stream_url="https://stream.epidemicsound.com/your-station",
        api_key="your-epidemic-api-key",
        metadata_path="your-stream-id",
        bitrate=256,
        codec="aac"
    )
    logger.info(f"Created Epidemic config: {epidemic_config.name}")

    # Icecast configuration (free, open source)
    icecast_config = StationConfig(
        provider=RadioStation.ICECAST.value,
        name="community-icecast",
        stream_url="http://icecast.example.com:8000/community-stream",
        bitrate=128,
        codec="mp3"
    )
    logger.info(f"Created Icecast config: {icecast_config.name}")

    logger.info("Demonstrated: StationConfig creation for different providers\n")


# Example 3: Metadata Handling
async def example_metadata_handling():
    """Example of fetching and handling metadata."""
    logger.info("=== Example 3: Metadata Handling ===")

    from radio_player import NowPlayingInfo

    # Create sample metadata
    now_playing = NowPlayingInfo(
        title="Lo-Fi Hip Hop Mix",
        artist="Various Artists",
        album="Beats to Study To",
        duration_seconds=3600,
        bitrate=128,
        codec="mp3",
        genre="Hip Hop",
        thumbnail_url="https://example.com/cover.jpg",
        updated_at=datetime.utcnow().isoformat()
    )

    logger.info(f"Now Playing: {now_playing.artist} - {now_playing.title}")
    logger.info(f"Album: {now_playing.album}")
    logger.info(f"Duration: {now_playing.duration_seconds}s")

    # Convert to dict for JSON serialization
    metadata_dict = now_playing.to_dict()
    logger.info(f"Serialized: {json.dumps(metadata_dict, indent=2)}")

    logger.info("Demonstrated: NowPlayingInfo and serialization\n")


# Example 4: WebSocket Overlay Integration
async def example_overlay_integration():
    """Example of sending updates to browser source overlay."""
    logger.info("=== Example 4: WebSocket Overlay Integration ===")

    from radio_player import NowPlayingInfo

    # Simulated WebSocket handler
    overlay_connections = {123: set()}  # community_id -> set of websockets

    async def send_to_overlay(community_id, message):
        """Send message to all connected WebSocket clients."""
        logger.info(f"Would send to {len(overlay_connections.get(community_id, set()))} overlay clients:")
        logger.info(json.dumps(message, indent=2))

    # Example message that would be sent
    example_update = {
        "type": "radio_update",
        "community_id": 123,
        "station": "pretzel-royalty-free",
        "provider": "pretzel",
        "now_playing": {
            "title": "Lofi Study Session",
            "artist": "Chillwave Radio",
            "album": "24/7 Stream",
            "updated_at": datetime.utcnow().isoformat()
        },
        "timestamp": datetime.utcnow().isoformat()
    }

    await send_to_overlay(123, example_update)
    logger.info("Demonstrated: Overlay WebSocket message format\n")


# Example 5: Multi-Community Setup
async def example_multi_community():
    """Example of managing radio across multiple communities."""
    logger.info("=== Example 5: Multi-Community Setup ===")

    player = create_radio_player(db_session=None)

    # Simulate communities
    communities = {
        123: "Gaming Community",
        456: "Study Community",
        789: "Music Community"
    }

    # Show how different communities could have different stations
    station_mapping = {
        123: "high-energy-gaming",
        456: "lofi-study",
        789: "music-discovery"
    }

    logger.info("Station assignments:")
    for community_id, community_name in communities.items():
        station_name = station_mapping[community_id]
        logger.info(f"  {community_name} (ID: {community_id}) -> {station_name}")

    # Show getting all active stations
    logger.info("To get all active stations: await player.get_active_stations()")
    logger.info("Demonstrated: Multi-community management\n")


# Example 6: Error Handling
async def example_error_handling():
    """Example of proper error handling."""
    logger.info("=== Example 6: Error Handling ===")

    player = create_radio_player(db_session=None)

    try:
        # Attempt to play a station
        success = await player.play_station(123, "non-existent-station")

        if not success:
            logger.error("Failed to start station - check configuration")

        # Check if any station is active
        station = await player.get_current_station(123)
        if station is None:
            logger.info("No station currently playing")

    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)

    finally:
        await player.shutdown()

    logger.info("Demonstrated: Error handling patterns\n")


# Example 7: Startup and Shutdown
async def example_lifecycle():
    """Example of proper initialization and cleanup."""
    logger.info("=== Example 7: Lifecycle Management ===")

    # Initialize player
    player = create_radio_player(db_session=None)
    logger.info("Player created")

    try:
        # In real app, call initialize() after database is ready
        await player.initialize()
        logger.info("Player initialized")

        # Simulate some operations
        await asyncio.sleep(1)

    finally:
        # Always cleanup
        await player.shutdown()
        logger.info("Player shutdown complete")

    logger.info("Demonstrated: Proper initialization and cleanup\n")


# Example 8: Complete Integration Example
async def example_complete_integration():
    """Complete example integrating multiple features."""
    logger.info("=== Example 8: Complete Integration ===")

    player = create_radio_player(db_session=None)

    try:
        # Step 1: Create configuration
        config = StationConfig(
            provider="pretzel",
            name="royalty-free-music",
            stream_url="https://stream.pretzel.rocks/default",
            api_endpoint="https://api.pretzel.rocks",
            api_key="example-key",
            bitrate=192,
            codec="mp3"
        )
        logger.info(f"1. Created config: {config.name}")

        # Step 2: Save configuration (in real app)
        logger.info("2. Would save config to database")

        # Step 3: Play station (in real app)
        logger.info("3. Would play: await player.play_station(123, 'royalty-free-music')")

        # Step 4: Get current status
        logger.info("4. Would get status: await player.get_current_station(123)")

        # Step 5: Fetch metadata periodically
        logger.info("5. Would fetch metadata: await player.get_now_playing(123)")

        # Step 6: Send overlay updates
        logger.info("6. Would send update: await player.send_overlay_update(123, handler)")

        # Step 7: Switch stations
        logger.info("7. Would switch: await player.stop_station(123) + play_station(123, ...)")

        # Step 8: Cleanup
        logger.info("8. Would cleanup: await player.shutdown()")

    finally:
        await player.shutdown()

    logger.info("Demonstrated: Complete integration workflow\n")


# Main runner
async def main():
    """Run all examples."""
    logger.info("RadioPlayer Service - Usage Examples\n")

    await example_basic_playback()
    await example_station_configuration()
    await example_metadata_handling()
    await example_overlay_integration()
    await example_multi_community()
    await example_error_handling()
    await example_lifecycle()
    await example_complete_integration()

    logger.info("=== All Examples Complete ===")


if __name__ == "__main__":
    asyncio.run(main())
