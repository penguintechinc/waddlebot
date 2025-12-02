"""
Unit tests for TokenManager service.
"""
import pytest
import asyncio
from datetime import datetime, timedelta
from pydal import DAL

from services.token_manager import TokenManager


@pytest.fixture
def db():
    """Create test database."""
    test_db = DAL("sqlite:memory:")
    yield test_db
    test_db.close()


@pytest.fixture
def token_manager(db):
    """Create TokenManager instance."""
    return TokenManager(
        db=db,
        client_id="test_client_id",
        client_secret="test_client_secret"
    )


@pytest.mark.asyncio
async def test_store_token(token_manager):
    """Test storing OAuth token."""
    result = await token_manager.store_token(
        broadcaster_id="123456",
        access_token="test_access_token",
        refresh_token="test_refresh_token",
        expires_in=3600,
        scopes=["chat:write", "moderator:manage:banned_users"]
    )

    assert result is True
    assert token_manager.has_token("123456")


@pytest.mark.asyncio
async def test_get_token_not_expired(token_manager):
    """Test getting token that is not expired."""
    # Store token with future expiration
    await token_manager.store_token(
        broadcaster_id="123456",
        access_token="test_access_token",
        refresh_token="test_refresh_token",
        expires_in=7200,  # 2 hours
        scopes=["chat:write"]
    )

    # Get token (should not refresh)
    token = await token_manager.get_token("123456")
    assert token == "test_access_token"


@pytest.mark.asyncio
async def test_has_token(token_manager):
    """Test checking if token exists."""
    # No token initially
    assert token_manager.has_token("123456") is False

    # Store token
    await token_manager.store_token(
        broadcaster_id="123456",
        access_token="test_access_token",
        refresh_token="test_refresh_token",
        expires_in=3600
    )

    # Token exists
    assert token_manager.has_token("123456") is True


@pytest.mark.asyncio
async def test_revoke_token(token_manager):
    """Test revoking token."""
    # Store token
    await token_manager.store_token(
        broadcaster_id="123456",
        access_token="test_access_token",
        refresh_token="test_refresh_token",
        expires_in=3600
    )

    assert token_manager.has_token("123456") is True

    # Revoke token
    result = await token_manager.revoke_token("123456")
    assert result is True
    assert token_manager.has_token("123456") is False


@pytest.mark.asyncio
async def test_update_existing_token(token_manager):
    """Test updating existing token."""
    # Store initial token
    await token_manager.store_token(
        broadcaster_id="123456",
        access_token="old_token",
        refresh_token="old_refresh",
        expires_in=3600
    )

    # Update with new token
    await token_manager.store_token(
        broadcaster_id="123456",
        access_token="new_token",
        refresh_token="new_refresh",
        expires_in=7200
    )

    # Should still be one record
    token = await token_manager.get_token("123456")
    assert token == "new_token"


def test_token_manager_initialization(db):
    """Test TokenManager initialization."""
    manager = TokenManager(
        db=db,
        client_id="test_id",
        client_secret="test_secret"
    )

    assert manager.client_id == "test_id"
    assert manager.client_secret == "test_secret"
    assert manager.token_url == "https://id.twitch.tv/oauth2/token"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
