"""Admin Controller"""
from quart import Blueprint
from flask_core import async_endpoint, success_response

admin_bp = Blueprint('admin', __name__)

@admin_bp.route('/status', methods=['GET'])
@async_endpoint
async def status():
    return success_response({"status": "operational"})
