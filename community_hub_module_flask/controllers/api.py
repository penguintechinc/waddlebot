"""
API Controllers - JSON endpoints for AJAX polling and integrations.
"""
from datetime import datetime
from functools import wraps

from quart import Blueprint, current_app, g, jsonify, request

from services.activity_service import ActivityService
from services.community_service import CommunityService
from services.coordination_service import CoordinationService
from services.module_integration_service import ModuleIntegrationService
from services.oauth_service import OAuthService

api_bp = Blueprint('api', __name__)


def get_dal():
    """Get DAL from app config."""
    return current_app.config.get('dal')


def get_current_user():
    """Get current user from session token."""
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None

    token = auth_header[7:]
    dal = get_dal()
    oauth_service = OAuthService(dal)
    return oauth_service.verify_session_token(token)


def require_auth(f):
    """Decorator to require authentication."""
    @wraps(f)
    async def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Authentication required'}), 401
        g.current_user = user
        return await f(*args, **kwargs)
    return decorated


@api_bp.route('/stats')
async def platform_stats():
    """Platform statistics JSON."""
    dal = get_dal()
    coord_service = CoordinationService(dal)

    community = g.get('community')
    community_id = community.id if community else None

    stats = await coord_service.get_platform_stats(community_id=community_id)

    return jsonify({
        'success': True,
        'stats': stats,
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/live')
async def live_streams():
    """Live streams JSON for polling."""
    dal = get_dal()
    coord_service = CoordinationService(dal)

    community = g.get('community')
    community_id = community.id if community else None

    limit = request.args.get('limit', 10, type=int)

    streams = await coord_service.get_live_streams(
        limit=min(limit, 50), community_id=community_id
    )

    return jsonify({
        'success': True,
        'streams': streams,
        'count': len(streams),
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/communities/<int:community_id>/activity')
async def community_activity(community_id: int):
    """Community activity feed for polling."""
    dal = get_dal()
    activity_service = ActivityService(dal)

    limit = request.args.get('limit', 20, type=int)
    since_str = request.args.get('since')

    since = None
    if since_str:
        try:
            since = datetime.fromisoformat(since_str.replace('Z', '+00:00'))
        except ValueError:
            pass

    activities = await activity_service.get_community_activity(
        community_id=community_id,
        limit=min(limit, 100),
        since=since
    )

    return jsonify({
        'success': True,
        'activities': activities,
        'count': len(activities),
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/communities/<int:community_id>/leaderboard')
async def community_leaderboard(community_id: int):
    """Community leaderboard JSON."""
    dal = get_dal()
    activity_service = ActivityService(dal)

    limit = request.args.get('limit', 10, type=int)

    leaderboard = await activity_service.get_leaderboard(
        community_id=community_id,
        limit=min(limit, 100)
    )

    return jsonify({
        'success': True,
        'leaderboard': leaderboard,
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/communities/<int:community_id>/members')
@require_auth
async def community_members(community_id: int):
    """Community members list (authenticated)."""
    dal = get_dal()
    community_service = CommunityService(dal)

    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)

    result = await community_service.get_community_members(
        community_id=community_id,
        page=page,
        per_page=per_page
    )

    return jsonify({
        'success': True,
        **result,
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/communities/<int:community_id>/dashboard')
async def community_dashboard(community_id: int):
    """Aggregated dashboard data (module integrations)."""
    dal = get_dal()
    integration_service = ModuleIntegrationService(dal)

    user = get_current_user()
    user_id = user.get('user_id') if user else None

    dashboard_data = await integration_service.get_hub_dashboard_data(
        community_id=community_id,
        user_id=user_id
    )

    return jsonify({
        'success': True,
        'data': dashboard_data,
        'authenticated': user_id is not None,
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/user/communities')
@require_auth
async def user_communities():
    """Get communities for current user."""
    dal = get_dal()
    oauth_service = OAuthService(dal)

    communities = await oauth_service.get_user_communities(
        g.current_user['user_id']
    )

    return jsonify({
        'success': True,
        'communities': communities,
        'timestamp': datetime.utcnow().isoformat()
    })


@api_bp.route('/user/profile')
@require_auth
async def user_profile():
    """Get current user profile."""
    return jsonify({
        'success': True,
        'user': g.current_user,
        'timestamp': datetime.utcnow().isoformat()
    })
