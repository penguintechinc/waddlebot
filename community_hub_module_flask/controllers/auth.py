"""
Auth Controllers - OAuth login/logout flows.
"""
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
from services.oauth_service import OAuthService

auth_bp = Blueprint('auth', __name__)


def get_dal():
    """Get DAL from app config."""
    return current_app.config.get('dal')


@auth_bp.route('/login')
async def login():
    """Login page with OAuth platform buttons."""
    # Check if already logged in
    token = session.get('session_token')
    if token:
        dal = get_dal()
        oauth_service = OAuthService(dal)
        user = oauth_service.verify_session_token(token)
        if user:
            return redirect(url_for('authenticated.dashboard'))

    # Get redirect target after login
    next_url = request.args.get('next', url_for('authenticated.dashboard'))

    return await render_template(
        'auth/login.html',
        platforms=Config.OAUTH_PLATFORMS,
        next_url=next_url
    )


@auth_bp.route('/oauth/<platform>')
async def oauth_start(platform: str):
    """Initiate OAuth flow for platform."""
    if platform not in Config.OAUTH_PLATFORMS:
        return await render_template(
            'auth/error.html',
            error=f'Unsupported platform: {platform}'
        ), 400

    dal = get_dal()
    oauth_service = OAuthService(dal)

    # Generate state token
    state = oauth_service.generate_state_token()
    session['oauth_state'] = state

    # Store next URL if provided
    next_url = request.args.get('next')
    if next_url:
        session['oauth_next'] = next_url

    # Build callback URL
    callback_url = url_for('auth.oauth_callback', platform=platform, _external=True)

    # Get OAuth URL from identity service
    result = await oauth_service.get_oauth_url(
        platform=platform,
        redirect_uri=callback_url,
        state=state
    )

    if not result.get('success'):
        return await render_template(
            'auth/error.html',
            error=result.get('error', 'Failed to start OAuth')
        ), 500

    return redirect(result['authorize_url'])


@auth_bp.route('/callback/<platform>')
async def oauth_callback(platform: str):
    """OAuth callback handler."""
    if platform not in Config.OAUTH_PLATFORMS:
        return await render_template(
            'auth/error.html',
            error=f'Unsupported platform: {platform}'
        ), 400

    # Verify state
    state = request.args.get('state')
    stored_state = session.pop('oauth_state', None)

    if not state or state != stored_state:
        return await render_template(
            'auth/error.html',
            error='Invalid OAuth state. Please try again.'
        ), 400

    # Check for errors
    error = request.args.get('error')
    if error:
        error_desc = request.args.get('error_description', error)
        return await render_template(
            'auth/error.html',
            error=f'OAuth error: {error_desc}'
        ), 400

    # Exchange code for tokens
    code = request.args.get('code')
    if not code:
        return await render_template(
            'auth/error.html',
            error='No authorization code received'
        ), 400

    dal = get_dal()
    oauth_service = OAuthService(dal)

    callback_url = url_for('auth.oauth_callback', platform=platform, _external=True)

    result = await oauth_service.exchange_code(
        platform=platform,
        code=code,
        redirect_uri=callback_url,
        state=state
    )

    if not result.get('success'):
        return await render_template(
            'auth/error.html',
            error=result.get('error', 'Failed to complete OAuth')
        ), 500

    # Store session token
    session['session_token'] = result['session_token']
    session['user'] = result['user']

    # Redirect to next URL or dashboard
    next_url = session.pop('oauth_next', None) or url_for('authenticated.dashboard')

    return await render_template(
        'auth/callback.html',
        user=result['user'],
        platform=platform,
        platform_info=Config.OAUTH_PLATFORMS[platform],
        next_url=next_url
    )


@auth_bp.route('/logout', methods=['POST'])
async def logout():
    """Logout and clear session."""
    token = session.get('session_token')

    if token:
        dal = get_dal()
        oauth_service = OAuthService(dal)
        await oauth_service.logout(token)

    session.clear()

    # Check for redirect URL
    next_url = request.args.get('next', url_for('public.home'))
    return redirect(next_url)


@auth_bp.route('/logout', methods=['GET'])
async def logout_page():
    """Logout confirmation page."""
    user = session.get('user')
    if not user:
        return redirect(url_for('public.home'))

    return await render_template('auth/logout.html', user=user)
