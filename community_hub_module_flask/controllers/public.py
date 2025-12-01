"""
Public Controllers - No authentication required.
"""
from quart import Blueprint, current_app, g, render_template, request

from services.community_service import CommunityService
from services.coordination_service import CoordinationService

public_bp = Blueprint('public', __name__)


def get_dal():
    """Get DAL from app config."""
    return current_app.config.get('dal')


@public_bp.route('/')
async def home():
    """Landing page with platform stats and live streams."""
    dal = get_dal()
    coord_service = CoordinationService(dal)
    community_service = CommunityService(dal)

    # Get community from domain context if available
    community = g.get('community')
    community_id = community.id if community else None

    # Get live streams
    live_streams = await coord_service.get_live_streams(
        limit=6, community_id=community_id
    )

    # Get platform stats
    platform_stats = await coord_service.get_platform_stats(
        community_id=community_id
    )

    # Get featured communities (only if not in community context)
    communities = []
    if not community:
        result = await community_service.get_public_communities(
            page=1, per_page=6
        )
        communities = result.get('communities', [])

    return await render_template(
        'public/home.html',
        community=community,
        live_streams=live_streams,
        platform_stats=platform_stats,
        communities=communities
    )


@public_bp.route('/communities')
async def community_list():
    """Browse all public communities."""
    dal = get_dal()
    community_service = CommunityService(dal)

    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 12, type=int)

    result = await community_service.get_public_communities(
        page=page, per_page=per_page
    )

    return await render_template(
        'public/community_list.html',
        communities=result['communities'],
        total=result['total'],
        page=result['page'],
        per_page=result['per_page'],
        total_pages=result['total_pages']
    )


@public_bp.route('/communities/<int:community_id>')
async def community_view(community_id: int):
    """View single community (public info)."""
    dal = get_dal()
    community_service = CommunityService(dal)
    coord_service = CoordinationService(dal)

    community = await community_service.get_community_public(community_id)
    if not community:
        return await render_template('public/not_found.html'), 404

    # Get live streams for this community
    live_streams = await coord_service.get_live_streams(
        limit=6, community_id=community_id
    )

    return await render_template(
        'public/community_view.html',
        community=community,
        live_streams=live_streams
    )


@public_bp.route('/live')
async def live_streams():
    """List of all live Twitch streams."""
    dal = get_dal()
    coord_service = CoordinationService(dal)

    # Get community from domain context if available
    community = g.get('community')
    community_id = community.id if community else None

    streams = await coord_service.get_live_streams(
        limit=50, community_id=community_id
    )

    recently_live = await coord_service.get_recently_live(
        limit=10, community_id=community_id
    )

    return await render_template(
        'public/live_streams.html',
        community=community,
        live_streams=streams,
        recently_live=recently_live
    )
