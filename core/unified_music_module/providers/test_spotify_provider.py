"""
Simple tests and examples for SpotifyProvider.

This is not a complete test suite but demonstrates basic functionality.
"""

import asyncio
from spotify_provider import SpotifyProvider


def test_parse_track_url():
    """Test the URL parser."""
    # Test standard URL
    url1 = "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"
    assert SpotifyProvider.parse_track_url(url1) == "3n3Ppam7vgaVa1iaRUc9Lp"

    # Test URL with query parameters
    url2 = "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abc123"
    assert SpotifyProvider.parse_track_url(url2) == "3n3Ppam7vgaVa1iaRUc9Lp"

    # Test Spotify URI
    uri = "spotify:track:3n3Ppam7vgaVa1iaRUc9Lp"
    assert SpotifyProvider.parse_track_url(uri) == "3n3Ppam7vgaVa1iaRUc9Lp"

    # Test invalid URL
    invalid = "https://example.com/some/path"
    assert SpotifyProvider.parse_track_url(invalid) is None

    print("URL parser tests passed!")


async def test_initialization():
    """Test basic initialization."""
    try:
        provider = SpotifyProvider()
        print(f"Provider initialized: {provider.PROVIDER_NAME}")
        print(f"Client ID configured: {bool(provider.client_id)}")
        await provider.close()
        print("Initialization test passed!")
    except ValueError as e:
        print(f"Expected error (missing env vars): {e}")


async def test_auth_url():
    """Test auth URL generation."""
    try:
        provider = SpotifyProvider()
        auth_url = provider.get_auth_url(state="test_state_123")
        print(f"Auth URL generated: {auth_url[:60]}...")

        # Check that URL contains expected components
        assert "accounts.spotify.com/authorize" in auth_url
        assert "client_id=" in auth_url
        assert "state=test_state_123" in auth_url
        assert "scope=" in auth_url

        await provider.close()
        print("Auth URL test passed!")
    except ValueError as e:
        print(f"Expected error (missing env vars): {e}")


def test_track_conversion():
    """Test conversion of Spotify track data to MusicTrack."""
    try:
        provider = SpotifyProvider()

        # Sample track data from Spotify API
        sample_track = {
            "id": "3n3Ppam7vgaVa1iaRUc9Lp",
            "name": "Never Gonna Give You Up",
            "artists": [
                {"name": "Rick Astley"}
            ],
            "album": {
                "name": "Whenever You Need Somebody",
                "images": [
                    {"url": "https://i.scdn.co/image/ab67616d0000b273.jpg"}
                ]
            },
            "duration_ms": 213000,
            "uri": "spotify:track:3n3Ppam7vgaVa1iaRUc9Lp",
            "popularity": 85,
            "explicit": False,
            "external_urls": {
                "spotify": "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"
            }
        }

        track = provider._convert_track(sample_track)

        assert track.track_id == "3n3Ppam7vgaVa1iaRUc9Lp"
        assert track.name == "Never Gonna Give You Up"
        assert track.artist == "Rick Astley"
        assert track.album == "Whenever You Need Somebody"
        assert track.duration_ms == 213000
        assert track.provider == "spotify"
        assert track.uri == "spotify:track:3n3Ppam7vgaVa1iaRUc9Lp"

        print(f"Track converted: {track.name} by {track.artist}")
        print("Track conversion test passed!")
    except ValueError as e:
        print(f"Expected error (missing env vars): {e}")


async def demo_usage():
    """Demonstrate typical usage pattern."""
    print("\n=== Spotify Provider Demo ===\n")

    try:
        # Initialize
        spotify = SpotifyProvider()
        print(f"1. Provider initialized: {spotify.PROVIDER_NAME}")

        # Generate auth URL
        auth_url = spotify.get_auth_url(state="demo_state")
        print(f"2. Auth URL: {auth_url[:60]}...")

        # Check if authenticated (will be False initially)
        is_authed = await spotify.is_authenticated()
        print(f"3. Authenticated: {is_authed}")

        # Parse a Spotify URL
        track_id = SpotifyProvider.parse_track_url(
            "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp?si=abc"
        )
        print(f"4. Parsed track ID: {track_id}")

        # Clean up
        await spotify.close()
        print("\n5. Demo completed successfully!")

    except ValueError as e:
        print(f"\nNote: {e}")
        print("Set environment variables to run full demo:")
        print("  export SPOTIFY_CLIENT_ID='your_client_id'")
        print("  export SPOTIFY_CLIENT_SECRET='your_client_secret'")
        print("  export SPOTIFY_REDIRECT_URI='http://localhost:8888/callback'")


def main():
    """Run all tests."""
    print("=" * 60)
    print("Spotify Provider Tests")
    print("=" * 60 + "\n")

    # Synchronous tests
    test_parse_track_url()
    print()

    test_track_conversion()
    print()

    # Async tests
    asyncio.run(test_initialization())
    print()

    asyncio.run(test_auth_url())
    print()

    asyncio.run(demo_usage())

    print("\n" + "=" * 60)
    print("All tests completed!")
    print("=" * 60)


if __name__ == "__main__":
    main()
