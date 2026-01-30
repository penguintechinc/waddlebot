"""
Video Proxy Module Configuration

Handles all configuration for the video proxy service including
database, gRPC, HTTP ports, MinIO, JWT settings, and license validation.
"""

import os
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Optional


@dataclass
class Config:
    """Main configuration class for video proxy module."""

    # Database Configuration
    DATABASE_URL: str = field(default_factory=lambda: (
        os.getenv('DATABASE_URL') or
        f"postgres://{os.getenv('DB_USER', 'waddlebot')}:{os.getenv('DB_PASS', 'password')}@"
        f"{os.getenv('DB_HOST', 'localhost')}:{os.getenv('DB_PORT', '5432')}/"
        f"{os.getenv('DB_NAME', 'waddlebot')}"
    ).replace('postgresql://', 'postgres://'))

    # HTTP Server Configuration
    MODULE_PORT: int = int(os.getenv('MODULE_PORT', '8092'))
    MODULE_HOST: str = os.getenv('MODULE_HOST', '0.0.0.0')

    # gRPC Configuration
    GRPC_PORT: int = int(os.getenv('GRPC_PORT', '50065'))
    GRPC_HOST: str = os.getenv('GRPC_HOST', '0.0.0.0')

    # MarchProxy gRPC Configuration
    MARCHPROXY_GRPC_HOST: str = os.getenv('MARCHPROXY_GRPC_HOST', 'localhost')
    MARCHPROXY_GRPC_PORT: int = int(os.getenv('MARCHPROXY_GRPC_PORT', '50050'))

    # Module Configuration
    MODULE_NAME: str = 'video_proxy_module'
    MODULE_VERSION: str = os.getenv('MODULE_VERSION', '1.0.0')
    MODULE_SECRET_KEY: str = os.getenv(
        'MODULE_SECRET_KEY',
        'change-me-in-production'
    )

    # JWT Configuration
    JWT_ALGORITHM: str = 'HS256'
    JWT_EXPIRATION: timedelta = timedelta(hours=1)
    JWT_REFRESH_EXPIRATION: timedelta = timedelta(days=7)
    JWT_SECRET_KEY: str = os.getenv(
        'JWT_SECRET_KEY',
        'jwt-secret-change-in-production'
    )

    # MinIO Configuration
    MINIO_ENDPOINT: str = os.getenv('MINIO_ENDPOINT', 'localhost:9000')
    MINIO_ACCESS_KEY: str = os.getenv('MINIO_ACCESS_KEY', 'minioadmin')
    MINIO_SECRET_KEY: str = os.getenv('MINIO_SECRET_KEY', 'minioadmin')
    MINIO_BUCKET: str = os.getenv('MINIO_BUCKET', 'video-proxy')
    MINIO_USE_SSL: bool = os.getenv('MINIO_USE_SSL', 'false').lower() == 'true'

    # License Server Configuration
    LICENSE_SERVER_URL: str = os.getenv(
        'LICENSE_SERVER_URL',
        'https://license.penguintech.io'
    )
    LICENSE_KEY: Optional[str] = os.getenv('LICENSE_KEY')
    RELEASE_MODE: bool = os.getenv('RELEASE_MODE', 'false').lower() == 'true'

    # Feature Limits
    FREE_MAX_DESTINATIONS: int = int(os.getenv('FREE_MAX_DESTINATIONS', '3'))
    FREE_MAX_2K_DESTINATIONS: int = int(os.getenv('FREE_MAX_2K_DESTINATIONS', '1'))

    # Logging Configuration
    LOG_LEVEL: str = os.getenv('LOG_LEVEL', 'INFO')
    LOG_FORMAT: str = os.getenv('LOG_FORMAT', 'text')

    # Database Connection Pool
    DB_POOL_SIZE: int = int(os.getenv('DB_POOL_SIZE', '10'))
    DB_POOL_RECYCLE: int = int(os.getenv('DB_POOL_RECYCLE', '3600'))

    # Redis Configuration (for caching)
    REDIS_HOST: str = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT: int = int(os.getenv('REDIS_PORT', '6379'))
    REDIS_PASSWORD: Optional[str] = os.getenv('REDIS_PASSWORD')
    REDIS_DB: int = int(os.getenv('REDIS_DB', '0'))

    # Timeout Configuration
    GRPC_TIMEOUT: int = int(os.getenv('GRPC_TIMEOUT', '30'))
    HTTP_TIMEOUT: int = int(os.getenv('HTTP_TIMEOUT', '30'))

    def validate(self) -> None:
        """
        Validate configuration settings.

        Raises:
            ValueError: If required settings are invalid or missing.
        """
        # Validate ports
        if not (1 <= self.MODULE_PORT <= 65535):
            raise ValueError(f'Invalid MODULE_PORT: {self.MODULE_PORT}')
        if not (1 <= self.GRPC_PORT <= 65535):
            raise ValueError(f'Invalid GRPC_PORT: {self.GRPC_PORT}')

        # Validate database URL
        if not self.DATABASE_URL:
            raise ValueError('DATABASE_URL must be set')

        # Validate JWT settings
        if not self.JWT_SECRET_KEY:
            raise ValueError('JWT_SECRET_KEY must be set')

        # Validate MinIO settings
        if not self.MINIO_ENDPOINT:
            raise ValueError('MINIO_ENDPOINT must be set')
        if not self.MINIO_ACCESS_KEY:
            raise ValueError('MINIO_ACCESS_KEY must be set')
        if not self.MINIO_SECRET_KEY:
            raise ValueError('MINIO_SECRET_KEY must be set')

        # Validate feature limits
        if self.FREE_MAX_DESTINATIONS < 1:
            raise ValueError('FREE_MAX_DESTINATIONS must be >= 1')
        if self.FREE_MAX_2K_DESTINATIONS < 0:
            raise ValueError('FREE_MAX_2K_DESTINATIONS must be >= 0')

        # Validate timeouts
        if self.GRPC_TIMEOUT < 1:
            raise ValueError('GRPC_TIMEOUT must be >= 1')
        if self.HTTP_TIMEOUT < 1:
            raise ValueError('HTTP_TIMEOUT must be >= 1')

        # License validation
        if self.RELEASE_MODE and not self.LICENSE_KEY:
            raise ValueError(
                'LICENSE_KEY required in RELEASE_MODE (development: '
                'RELEASE_MODE=false)'
            )


def get_config() -> Config:
    """
    Get the current configuration instance.

    Returns:
        Config: The configuration object.
    """
    config = Config()
    config.validate()
    return config
