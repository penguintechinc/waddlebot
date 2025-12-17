"""
Music Services Module

Provides unified services for music and radio playback:
- unified_queue: Cross-provider music queue with voting
- radio_player: Single-stream radio playback
- mode_controller: Coordinates switching between music and radio modes
"""

from .unified_queue import UnifiedQueue, QueueItem, QueueStatus, create_unified_queue
from .radio_player import RadioPlayer, RadioStation, StationConfig, NowPlayingInfo, create_radio_player
from .mode_controller import ModeController, PlayMode, ModeState, create_mode_controller

__all__ = [
    'UnifiedQueue',
    'QueueItem',
    'QueueStatus',
    'create_unified_queue',
    'RadioPlayer',
    'RadioStation',
    'StationConfig',
    'NowPlayingInfo',
    'create_radio_player',
    'ModeController',
    'PlayMode',
    'ModeState',
    'create_mode_controller',
]
