"""
OAuth Service - Manages OAuth authentication flows.

Leverages identity_core_module for OAuth handling rather than reimplementing.
"""
import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx
import jwt

from config import Config


class OAuthService:
    """Service for OAuth authentication management."""

    def __init__(self, dal):
        self.dal = dal
        self.identity_api_url = Config.IDENTITY_API_URL
        self.secret_key = Config.JWT_SECRET_KEY
        self.session_ttl = Config.SESSION_TTL

    def generate_state_token(self) -> str:
        """Generate a secure state token for OAuth flow."""
        return secrets.token_urlsafe(32)

    async def get_oauth_url(
        self,
        platform: str,
        redirect_uri: str,
        state: str
    ) -> Dict[str, Any]:
        """Get OAuth authorization URL from identity service."""
        if platform not in Config.OAUTH_PLATFORMS:
            return {'success': False, 'error': f'Unsupported platform: {platform}'}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.identity_api_url}/auth/oauth/{platform}/authorize",
                    params={
                        'redirect_uri': redirect_uri,
                        'state': state
                    },
                    timeout=10.0
                )

                if response.status_code == 200:
                    data = response.json()
                    return {
                        'success': True,
                        'authorize_url': data.get('authorize_url'),
                        'platform': platform
                    }
                else:
                    return {
                        'success': False,
                        'error': f'Identity service error: {response.status_code}'
                    }
        except httpx.TimeoutException:
            return {'success': False, 'error': 'Identity service timeout'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    async def exchange_code(
        self,
        platform: str,
        code: str,
        redirect_uri: str,
        state: str
    ) -> Dict[str, Any]:
        """Exchange authorization code for user info."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.identity_api_url}/auth/oauth/{platform}/callback",
                    json={
                        'code': code,
                        'redirect_uri': redirect_uri,
                        'state': state
                    },
                    timeout=15.0
                )

                if response.status_code == 200:
                    data = response.json()
                    # Create session token for the user
                    session_token = self.create_session_token(
                        user_id=data.get('user_id'),
                        platform=platform,
                        platform_user_id=data.get('platform_user_id'),
                        user_name=data.get('user_name'),
                        avatar_url=data.get('avatar_url')
                    )
                    return {
                        'success': True,
                        'session_token': session_token,
                        'user': {
                            'user_id': data.get('user_id'),
                            'platform': platform,
                            'platform_user_id': data.get('platform_user_id'),
                            'user_name': data.get('user_name'),
                            'avatar_url': data.get('avatar_url')
                        }
                    }
                else:
                    return {
                        'success': False,
                        'error': f'OAuth exchange failed: {response.status_code}'
                    }
        except httpx.TimeoutException:
            return {'success': False, 'error': 'Identity service timeout'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def create_session_token(
        self,
        user_id: str,
        platform: str,
        platform_user_id: str,
        user_name: str,
        avatar_url: Optional[str] = None
    ) -> str:
        """Create a JWT session token."""
        payload = {
            'user_id': user_id,
            'platform': platform,
            'platform_user_id': platform_user_id,
            'user_name': user_name,
            'avatar_url': avatar_url,
            'iat': datetime.utcnow(),
            'exp': datetime.utcnow() + timedelta(seconds=self.session_ttl)
        }
        return jwt.encode(payload, self.secret_key, algorithm='HS256')

    def verify_session_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Verify and decode a session token."""
        try:
            payload = jwt.decode(token, self.secret_key, algorithms=['HS256'])
            return {
                'user_id': payload.get('user_id'),
                'platform': payload.get('platform'),
                'platform_user_id': payload.get('platform_user_id'),
                'user_name': payload.get('user_name'),
                'avatar_url': payload.get('avatar_url')
            }
        except jwt.ExpiredSignatureError:
            return None
        except jwt.InvalidTokenError:
            return None

    def refresh_session_token(self, token: str) -> Optional[str]:
        """Refresh a session token if still valid."""
        user_data = self.verify_session_token(token)
        if not user_data:
            return None

        return self.create_session_token(
            user_id=user_data['user_id'],
            platform=user_data['platform'],
            platform_user_id=user_data['platform_user_id'],
            user_name=user_data['user_name'],
            avatar_url=user_data.get('avatar_url')
        )

    async def get_user_communities(self, user_id: str) -> list:
        """Get communities the user is a member of."""
        def _query():
            db = self.dal.dal
            memberships = db(
                (db.community_memberships.user_id == user_id) &
                (db.community_memberships.is_active == True)  # noqa: E712
            ).select()

            communities = []
            for m in memberships:
                community = db(db.communities.id == m.community_id).select().first()
                if community and community.is_active:
                    communities.append({
                        'id': community.id,
                        'name': community.name,
                        'joined_at': m.joined_at.isoformat() if m.joined_at else None
                    })
            return communities

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def logout(self, token: str) -> Dict[str, Any]:
        """Invalidate a session token (optional blacklist)."""
        # For stateless JWT, logout is typically handled client-side
        # Optional: Add to blacklist in Redis for immediate invalidation
        return {'success': True, 'message': 'Logged out successfully'}
