import os
from typing import Optional


class Config:
    """Engagement Module Configuration"""
    
    # Database Configuration - builds URL from DB_* vars if DATABASE_URL not set
    DATABASE_URL: str = (
        os.getenv("DATABASE_URL") or
        f"postgres://{os.getenv('DB_USER', 'waddlebot')}:{os.getenv('DB_PASS', 'password')}@"
        f"{os.getenv('DB_HOST', 'localhost')}:{os.getenv('DB_PORT', '5432')}/"
        f"{os.getenv('DB_NAME', 'waddlebot')}"
    ).replace('postgresql://', 'postgres://')
    DB_POOL_SIZE: int = int(os.getenv("DB_POOL_SIZE", "10"))
    
    # Module Configuration
    MODULE_NAME: str = "engagement_module"
    MODULE_PORT: int = int(os.getenv("MODULE_PORT", "8091"))
    MODULE_HOST: str = os.getenv("MODULE_HOST", "0.0.0.0")
    MODULE_VERSION: str = os.getenv("MODULE_VERSION", "1.0.0")
    MODULE_SECRET_KEY: str = os.getenv("MODULE_SECRET_KEY", "change-me-in-production")
    
    # gRPC Configuration
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50061"))
    GRPC_HOST: str = os.getenv("GRPC_HOST", "0.0.0.0")
    
    # JWT Configuration
    JWT_SECRET: str = os.getenv("JWT_SECRET", "jwt-secret-key-change-in-prod")
    JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
    JWT_EXPIRATION_HOURS: int = int(os.getenv("JWT_EXPIRATION_HOURS", "24"))
    
    # Logging Configuration
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_FORMAT: str = os.getenv("LOG_FORMAT", "text")  # text or json
    
    # Environment
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    RELEASE_MODE: bool = os.getenv("RELEASE_MODE", "false").lower() == "true"
    
    # License Configuration (if applicable)
    LICENSE_KEY: Optional[str] = os.getenv("LICENSE_KEY")
    LICENSE_SERVER: str = os.getenv("LICENSE_SERVER", "https://license.penguintech.io")
    
    @classmethod
    def validate(cls) -> bool:
        """Validate configuration settings"""
        required_vars = ["MODULE_SECRET_KEY", "JWT_SECRET"]
        
        for var in required_vars:
            value = getattr(cls, var, None)
            if not value or value in ("change-me-in-production", "jwt-secret-key-change-in-prod"):
                if cls.ENVIRONMENT == "production":
                    raise ValueError(f"Required configuration {var} not properly set for production")
        
        # Validate ports
        if not (1 <= cls.MODULE_PORT <= 65535):
            raise ValueError(f"Invalid MODULE_PORT: {cls.MODULE_PORT}")
        if not (1 <= cls.GRPC_PORT <= 65535):
            raise ValueError(f"Invalid GRPC_PORT: {cls.GRPC_PORT}")
        
        return True
