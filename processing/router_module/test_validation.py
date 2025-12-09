#!/usr/bin/env python3
"""
Test script for router module validation models.

This script validates that the Pydantic models work correctly
and can be imported and instantiated.
"""

import sys
import os

# Add libs to path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from pydantic import ValidationError
from validation_models import RouterEventRequest, RouterBatchRequest, RouterResponseRequest


def test_router_event_request():
    """Test RouterEventRequest validation."""
    print("Testing RouterEventRequest...")

    # Valid data
    valid_data = {
        "platform": "twitch",
        "channel_id": "channel123",
        "user_id": "user456",
        "username": "testuser",
        "message": "!help",
        "command": "help",
        "metadata": {"timestamp": "2025-12-09"}
    }

    try:
        event = RouterEventRequest(**valid_data)
        print(f"  ✓ Valid event created: {event.platform}/{event.username}/{event.message}")
        assert event.platform == "twitch"
        assert event.command == "help"
    except ValidationError as e:
        print(f"  ✗ Unexpected validation error: {e}")
        return False

    # Invalid platform
    invalid_platform = valid_data.copy()
    invalid_platform["platform"] = "invalid"
    try:
        RouterEventRequest(**invalid_platform)
        print("  ✗ Should have rejected invalid platform")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected invalid platform")

    # Message too long
    invalid_message = valid_data.copy()
    invalid_message["message"] = "x" * 5001
    try:
        RouterEventRequest(**invalid_message)
        print("  ✗ Should have rejected message > 5000 chars")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected message > 5000 chars")

    # Empty channel_id
    invalid_channel = valid_data.copy()
    invalid_channel["channel_id"] = "   "
    try:
        RouterEventRequest(**invalid_channel)
        print("  ✗ Should have rejected empty channel_id")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected empty channel_id")

    # Extra field (should be rejected due to Config.extra = 'forbid')
    extra_field = valid_data.copy()
    extra_field["extra_field"] = "should_fail"
    try:
        RouterEventRequest(**extra_field)
        print("  ✗ Should have rejected extra field")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected extra field")

    print("  ✓ All RouterEventRequest tests passed!\n")
    return True


def test_router_batch_request():
    """Test RouterBatchRequest validation."""
    print("Testing RouterBatchRequest...")

    # Valid batch
    event1 = {
        "platform": "discord",
        "channel_id": "channel1",
        "user_id": "user1",
        "username": "user1",
        "message": "!ping"
    }

    event2 = {
        "platform": "slack",
        "channel_id": "channel2",
        "user_id": "user2",
        "username": "user2",
        "message": "!status"
    }

    valid_batch = {
        "events": [event1, event2]
    }

    try:
        batch = RouterBatchRequest(**valid_batch)
        print(f"  ✓ Valid batch created with {len(batch.events)} events")
        assert len(batch.events) == 2
    except ValidationError as e:
        print(f"  ✗ Unexpected validation error: {e}")
        return False

    # Empty batch
    try:
        RouterBatchRequest(events=[])
        print("  ✗ Should have rejected empty batch")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected empty batch")

    # Batch too large (> 100)
    large_batch = {"events": [event1] * 101}
    try:
        RouterBatchRequest(**large_batch)
        print("  ✗ Should have rejected batch > 100 items")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected batch > 100 items")

    print("  ✓ All RouterBatchRequest tests passed!\n")
    return True


def test_router_response_request():
    """Test RouterResponseRequest validation."""
    print("Testing RouterResponseRequest...")

    # Valid response
    valid_response = {
        "event_id": "evt_123",
        "response": "Command executed successfully!",
        "platform": "twitch",
        "channel_id": "channel123"
    }

    try:
        response = RouterResponseRequest(**valid_response)
        print(f"  ✓ Valid response created: {response.event_id} -> {response.response}")
        assert response.platform == "twitch"
    except ValidationError as e:
        print(f"  ✗ Unexpected validation error: {e}")
        return False

    # Empty response
    invalid_response = valid_response.copy()
    invalid_response["response"] = "   "
    try:
        RouterResponseRequest(**invalid_response)
        print("  ✗ Should have rejected empty response")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected empty response")

    # Response too long
    invalid_long = valid_response.copy()
    invalid_long["response"] = "x" * 5001
    try:
        RouterResponseRequest(**invalid_long)
        print("  ✗ Should have rejected response > 5000 chars")
        return False
    except ValidationError:
        print("  ✓ Correctly rejected response > 5000 chars")

    print("  ✓ All RouterResponseRequest tests passed!\n")
    return True


def main():
    """Run all validation tests."""
    print("=" * 60)
    print("Router Module Validation Models Test Suite")
    print("=" * 60 + "\n")

    results = []
    results.append(test_router_event_request())
    results.append(test_router_batch_request())
    results.append(test_router_response_request())

    print("=" * 60)
    if all(results):
        print("✓ ALL TESTS PASSED!")
        print("=" * 60)
        return 0
    else:
        print("✗ SOME TESTS FAILED")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
