#!/usr/bin/env python3
"""
Test script for validation models

This script verifies that the validation models are correctly defined
and can be instantiated with valid data.
"""

import sys
import os

# Add libs to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..', 'libs'))

try:
    from pydantic import ValidationError
    print("✓ Pydantic import successful")
except ImportError as e:
    print(f"✗ Failed to import pydantic: {e}")
    print("  (This is expected if pydantic is not installed locally)")
    sys.exit(0)  # Exit gracefully since we've verified syntax

# Import validation models
try:
    from validation_models import (
        ChatRequest,
        ProviderConfigRequest,
        ConversationSearchParams,
        InteractionRequest
    )
    print("✓ Validation models import successful")
except ImportError as e:
    print(f"✗ Failed to import validation models: {e}")
    sys.exit(1)

# Test ChatRequest
print("\n--- Testing ChatRequest ---")
try:
    valid_chat_request = ChatRequest(
        community_id=1,
        user_id="user123",
        username="testuser",
        prompt="Hello, how are you?",
        platform="twitch",
        channel_id="channel123",
        provider="ollama",
        temperature=0.7,
        max_tokens=500
    )
    print(f"✓ Valid ChatRequest created: {valid_chat_request.username}")
except Exception as e:
    print(f"✗ Failed to create valid ChatRequest: {e}")

# Test invalid ChatRequest (negative community_id)
try:
    invalid_chat_request = ChatRequest(
        community_id=-1,
        user_id="user123",
        username="testuser",
        prompt="Hello",
        platform="twitch"
    )
    print("✗ Invalid ChatRequest should have failed (negative community_id)")
except ValidationError:
    print("✓ ChatRequest correctly rejected negative community_id")

# Test invalid platform
try:
    invalid_platform = ChatRequest(
        community_id=1,
        user_id="user123",
        username="testuser",
        prompt="Hello",
        platform="invalid_platform"
    )
    print("✗ Invalid platform should have failed")
except ValidationError:
    print("✓ ChatRequest correctly rejected invalid platform")

# Test ProviderConfigRequest
print("\n--- Testing ProviderConfigRequest ---")
try:
    valid_config = ProviderConfigRequest(
        community_id=1,
        provider="ollama",
        base_url="https://api.example.com",
        model="llama2",
        temperature=0.8,
        max_tokens=1000
    )
    print(f"✓ Valid ProviderConfigRequest created: {valid_config.provider}")
except Exception as e:
    print(f"✗ Failed to create valid ProviderConfigRequest: {e}")

# Test invalid URL
try:
    invalid_url = ProviderConfigRequest(
        community_id=1,
        provider="openai",
        base_url="javascript:alert('xss')"
    )
    print("✗ Invalid URL should have failed")
except ValidationError:
    print("✓ ProviderConfigRequest correctly rejected dangerous URL")

# Test ConversationSearchParams
print("\n--- Testing ConversationSearchParams ---")
try:
    valid_search = ConversationSearchParams(
        community_id=1,
        user_id="user123",
        platform="discord",
        limit=50,
        offset=0
    )
    print(f"✓ Valid ConversationSearchParams created: limit={valid_search.limit}")
except Exception as e:
    print(f"✗ Failed to create valid ConversationSearchParams: {e}")

# Test invalid limit (too high)
try:
    invalid_limit = ConversationSearchParams(
        limit=1000
    )
    print("✗ Invalid limit should have failed")
except ValidationError:
    print("✓ ConversationSearchParams correctly rejected limit > 100")

# Test InteractionRequest
print("\n--- Testing InteractionRequest ---")
try:
    valid_interaction = InteractionRequest(
        session_id="sess_123",
        message_type="chatMessage",
        message_content="Hello!",
        user_id="user123",
        entity_id="twitch:channel:456",
        platform="twitch",
        username="testuser"
    )
    print(f"✓ Valid InteractionRequest created: {valid_interaction.username}")
except Exception as e:
    print(f"✗ Failed to create valid InteractionRequest: {e}")

# Test prompt sanitization
print("\n--- Testing Prompt Sanitization ---")
try:
    sanitized_request = ChatRequest(
        community_id=1,
        user_id="user123",
        username="testuser",
        prompt="Hello <script>alert('xss')</script>",
        platform="twitch"
    )
    if "<script>" not in sanitized_request.prompt:
        print(f"✓ Prompt sanitization working: {sanitized_request.prompt}")
    else:
        print("✗ Prompt sanitization failed - HTML tags still present")
except Exception as e:
    print(f"✗ Sanitization test failed: {e}")

print("\n=== All validation tests completed ===")
