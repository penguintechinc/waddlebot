"""
Authenticated Controllers - Require login.
"""
from functools import wraps

from quart import (
    Blueprint,
    current_app,
    g,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from config import Config
from services.activity_service import ActivityService
from services.community_service import CommunityService
from services.coordination_service import CoordinationService
from services.module_integration_service import ModuleIntegrationService
from services.oauth_service import OAuthService

authenticated_bp = Blueprint('authenticated', __name__)


def get_dal():
    """Get DAL from app config."""
    return current_app.config.get('dal')


def require_login(f):
    """Decorator to require login."""
    @wraps(f)
    async def decorated(*args, **kwargs):
        token = session.get('session_token')
        if not token:
            return redirect(url_for('auth.login', next=request.url))

        dal = get_dal()
        oauth_service = OAuthService(dal)
        user = oauth_service.verify_session_token(token)

        if not user:
            session.clear()
            return redirect(url_for('auth.login', next=request.url))

        g.current_user = user
        return await f(*args, **kwargs)
    return decorated


@authenticated_bp.route('/dashboard')
@require_login
async def dashboard():
    """User dashboard showing their communities."""
    dal = get_dal()
    oauth_service = OAuthService(dal)
    activity_service = ActivityService(dal)

    # Get user's communities
    communities = await oauth_service.get_user_communities(
        g.current_user['user_id']
    )

    # Get activity summary for each community
    for community in communities:
        summary = await activity_service.get_activity_summary(
            community['id'], hours=24
        )
        community['activity_summary'] = summary

    return await render_template(
        'authenticated/dashboard.html',
        user=g.current_user,
        communities=communities
    )


@authenticated_bp.route('/communities/<int:community_id>/members')
@require_login
async def members(community_id: int):
    """Member list view with reputation scores."""
    dal = get_dal()
    community_service = CommunityService(dal)

    # Check if user is member of community
    is_member = await community_service.is_user_member(
        community_id, g.current_user['user_id']
    )
    if not is_member:
        return await render_template('authenticated/access_denied.html'), 403

    community = await community_service.get_community_detail(
        community_id, g.current_user['user_id']
    )
    if not community:
        return await render_template('public/not_found.html'), 404

    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)

    members_result = await community_service.get_community_members(
        community_id=community_id,
        page=page,
        per_page=per_page
    )

    return await render_template(
        'authenticated/members.html',
        user=g.current_user,
        community=community,
        members=members_result['members'],
        total=members_result['total'],
        page=members_result['page'],
        per_page=members_result['per_page'],
        total_pages=members_result['total_pages']
    )


@authenticated_bp.route('/communities/<int:community_id>/activity')
@require_login
async def activity_feed(community_id: int):
    """Cross-platform activity feed."""
    dal = get_dal()
    community_service = CommunityService(dal)
    activity_service = ActivityService(dal)

    # Check if user is member of community
    is_member = await community_service.is_user_member(
        community_id, g.current_user['user_id']
    )
    if not is_member:
        return await render_template('authenticated/access_denied.html'), 403

    community = await community_service.get_community_public(community_id)
    if not community:
        return await render_template('public/not_found.html'), 404

    # Get recent activity
    activities = await activity_service.get_community_activity(
        community_id=community_id,
        limit=50
    )

    # Get activity summary
    summary = await activity_service.get_activity_summary(
        community_id, hours=24
    )

    return await render_template(
        'authenticated/activity_feed.html',
        user=g.current_user,
        community=community,
        activities=activities,
        summary=summary,
        polling_interval=Config.POLLING_INTERVAL_ACTIVITY
    )


@authenticated_bp.route('/communities/<int:community_id>/hub')
@require_login
async def community_hub(community_id: int):
    """Full community hub view with module integrations."""
    dal = get_dal()
    community_service = CommunityService(dal)
    coord_service = CoordinationService(dal)
    activity_service = ActivityService(dal)
    integration_service = ModuleIntegrationService(dal)

    community = await community_service.get_community_detail(
        community_id, g.current_user['user_id']
    )
    if not community:
        return await render_template('public/not_found.html'), 404

    # Get live streams
    live_streams = await coord_service.get_live_streams(
        limit=6, community_id=community_id
    )

    # Get activity
    activities = await activity_service.get_community_activity(
        community_id=community_id, limit=10
    )

    # Get leaderboard
    leaderboard = await activity_service.get_leaderboard(
        community_id=community_id, limit=5
    )

    # Get module data
    dashboard_data = await integration_service.get_hub_dashboard_data(
        community_id=community_id,
        user_id=g.current_user['user_id']
    )

    return await render_template(
        'authenticated/hub.html',
        user=g.current_user,
        community=community,
        live_streams=live_streams,
        activities=activities,
        leaderboard=leaderboard,
        dashboard_data=dashboard_data,
        polling_interval_live=Config.POLLING_INTERVAL_LIVE,
        polling_interval_activity=Config.POLLING_INTERVAL_ACTIVITY
    )


@authenticated_bp.route('/profile')
@require_login
async def profile():
    """User's own profile."""
    dal = get_dal()
    oauth_service = OAuthService(dal)
    activity_service = ActivityService(dal)

    # Get user's communities
    communities = await oauth_service.get_user_communities(
        g.current_user['user_id']
    )

    # Get user activity in each community
    community_stats = []
    for community in communities:
        user_activity = await activity_service.get_user_activity(
            community['id'], g.current_user['user_id'], limit=5
        )
        community_stats.append({
            **community,
            'recent_activity': user_activity
        })

    return await render_template(
        'authenticated/profile.html',
        user=g.current_user,
        communities=community_stats
    )
