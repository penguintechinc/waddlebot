"""Workflow Core Module - Quart Application"""
import asyncio
import os
import sys

from quart import Blueprint, Quart

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from config import Config  # noqa: E402
from flask_core import (  # noqa: E402
    async_endpoint, create_health_blueprint, init_database, setup_aaa_logging, success_response,
)

# Import services
from services.license_service import LicenseService  # noqa: E402
from services.permission_service import PermissionService  # noqa: E402
from services.validation_service import WorkflowValidationService  # noqa: E402
from services.workflow_service import WorkflowService  # noqa: E402

# Import controllers
from controllers.workflow_api import register_workflow_api  # noqa: E402
from controllers.execution_api import register_execution_api  # noqa: E402

app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

# API Blueprint for v1
api_bp = Blueprint('api', __name__, url_prefix='/api/v1')

# Initialize logging
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

# Service instances
dal = None
license_service = None
permission_service = None
validation_service = None
workflow_service = None
workflow_engine = None


@app.before_serving
async def startup():
    """Initialize application on startup"""
    global dal, license_service, permission_service, validation_service, workflow_service, workflow_engine

    logger.system(
        "Starting workflow_core_module",
        action="startup",
        extra={"port": Config.PORT, "feature_workflows": Config.FEATURE_WORKFLOWS_ENABLED}
    )
    try:
        # Initialize database
        dal = init_database(Config.DATABASE_URI)
        app.config['dal'] = dal

        # Initialize services
        license_service = LicenseService(
            license_server_url=Config.LICENSE_SERVER_URL,
            redis_url=Config.REDIS_URL,
            release_mode=Config.RELEASE_MODE,
            logger_instance=logger
        )
        await license_service.connect()

        permission_service = PermissionService(dal=dal, logger=logger)
        app.config['permission_service'] = permission_service

        validation_service = WorkflowValidationService()

        workflow_service = WorkflowService(
            dal=dal,
            license_service=license_service,
            permission_service=permission_service,
            validation_service=validation_service,
            logger_instance=logger
        )
        app.config['workflow_service'] = workflow_service

        # Initialize workflow engine
        from services.workflow_engine import WorkflowEngine
        workflow_engine = WorkflowEngine(
            dal=dal,
            router_url=Config.ROUTER_URL,
            max_loop_iterations=Config.MAX_LOOP_ITERATIONS,
            max_total_operations=Config.MAX_TOTAL_OPERATIONS,
            max_loop_depth=Config.MAX_LOOP_DEPTH,
            default_timeout=Config.WORKFLOW_TIMEOUT,
            max_parallel_nodes=Config.MAX_PARALLEL_NODES
        )
        app.config['workflow_engine'] = workflow_engine

        # Register workflow API
        register_workflow_api(app, workflow_service)

        # Register execution API
        register_execution_api(app, workflow_engine)

        logger.system("workflow_core_module started successfully", result="SUCCESS")
    except Exception as e:
        logger.error(f"Failed to start workflow_core_module: {str(e)}", result="FAILURE")
        raise


@app.after_serving
async def shutdown():
    """Cleanup on shutdown"""
    global license_service, workflow_engine

    logger.system("Shutting down workflow_core_module", action="shutdown")
    try:
        # Shutdown workflow engine
        if workflow_engine:
            workflow_engine.shutdown()

        # Disconnect license service
        if license_service:
            await license_service.disconnect()

        # Close database connection if needed
        if dal:
            pass

        logger.system("workflow_core_module shutdown complete", result="SUCCESS")
    except Exception as e:
        logger.error(f"Error during shutdown: {str(e)}", result="FAILURE")


@api_bp.route('/status', methods=['GET'])
@async_endpoint
async def status():
    """Get workflow module status"""
    return success_response({
        "status": "operational",
        "module": Config.MODULE_NAME,
        "version": Config.MODULE_VERSION,
        "features": {
            "workflows_enabled": Config.FEATURE_WORKFLOWS_ENABLED,
            "release_mode": Config.RELEASE_MODE
        }
    })


@api_bp.route('/health', methods=['GET'])
@async_endpoint
async def health_check():
    """Health check endpoint"""
    return success_response({
        "healthy": True,
        "module": Config.MODULE_NAME
    })


# Register API blueprint
app.register_blueprint(api_bp)


if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
