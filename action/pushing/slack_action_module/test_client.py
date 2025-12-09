#!/usr/bin/env python3
"""
Test client for Slack Action Module
Demonstrates both REST API and gRPC usage
"""
import requests
import json
import sys

# Configuration
REST_API_URL = "http://localhost:8071"
GRPC_HOST = "localhost:50052"
MODULE_SECRET_KEY = "your-module-secret-key"


def get_jwt_token(api_key: str, client_id: str = "test-client") -> str:
    """Get JWT token for API authentication"""
    print("Getting JWT token...")

    response = requests.post(
        f"{REST_API_URL}/api/v1/token",
        json={
            "api_key": api_key,
            "client_id": client_id
        }
    )

    if response.status_code == 200:
        token_data = response.json()
        print(f"✓ Token obtained (expires in {token_data['expires_in']}s)")
        return token_data['token']
    else:
        print(f"✗ Failed to get token: {response.text}")
        sys.exit(1)


def test_health_check():
    """Test health check endpoint"""
    print("\n--- Testing Health Check ---")

    response = requests.get(f"{REST_API_URL}/health")

    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")


def test_send_message(token: str):
    """Test sending message via REST API"""
    print("\n--- Testing Send Message ---")

    response = requests.post(
        f"{REST_API_URL}/api/v1/message",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json={
            "community_id": "test-community",
            "channel_id": "C01234567",
            "text": "Hello from WaddleBot test client!",
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "*Test Message*\nThis is a test from the Slack Action Module"
                    }
                }
            ]
        }
    )

    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")


def test_add_reaction(token: str):
    """Test adding reaction via REST API"""
    print("\n--- Testing Add Reaction ---")

    response = requests.post(
        f"{REST_API_URL}/api/v1/reaction",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json={
            "community_id": "test-community",
            "channel_id": "C01234567",
            "ts": "1234567890.123456",
            "emoji": "thumbsup"
        }
    )

    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")


def test_get_history(token: str):
    """Test getting action history via REST API"""
    print("\n--- Testing Get History ---")

    response = requests.get(
        f"{REST_API_URL}/api/v1/history/test-community?limit=10",
        headers={
            "Authorization": f"Bearer {token}"
        }
    )

    print(f"Status Code: {response.status_code}")
    history = response.json().get('history', [])
    print(f"Found {len(history)} action(s)")

    for i, action in enumerate(history[:5], 1):
        print(f"\n  Action {i}:")
        print(f"    Type: {action.get('action_type')}")
        print(f"    Success: {action.get('success')}")
        print(f"    Time: {action.get('created_at')}")


def test_grpc_client():
    """Test gRPC client"""
    print("\n--- Testing gRPC Client ---")

    try:
        import grpc
        from proto import slack_action_pb2, slack_action_pb2_grpc

        # Create channel
        channel = grpc.insecure_channel(GRPC_HOST)
        stub = slack_action_pb2_grpc.SlackActionServiceStub(channel)

        # Send message
        request = slack_action_pb2.SendMessageRequest(
            community_id='test-community',
            channel_id='C01234567',
            text='Hello from gRPC test client!'
        )

        response = stub.SendMessage(request)

        print(f"Success: {response.success}")
        print(f"Message TS: {response.message_ts}")
        if response.error:
            print(f"Error: {response.error}")

        channel.close()

    except ImportError:
        print("✗ gRPC proto files not found. Run: python -m grpc_tools.protoc ...")
    except Exception as e:
        print(f"✗ gRPC test failed: {e}")


def main():
    """Run all tests"""
    print("=" * 60)
    print("Slack Action Module - Test Client")
    print("=" * 60)

    # Test health check (no auth required)
    test_health_check()

    # Get JWT token
    token = get_jwt_token(MODULE_SECRET_KEY)

    # Test REST API endpoints
    test_send_message(token)
    test_add_reaction(token)
    test_get_history(token)

    # Test gRPC client
    test_grpc_client()

    print("\n" + "=" * 60)
    print("All tests completed!")
    print("=" * 60)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        MODULE_SECRET_KEY = sys.argv[1]

    main()
