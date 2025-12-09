#!/usr/bin/env python3
"""
Test script to validate Lambda Action Module structure
"""

import sys
from pathlib import Path


def test_structure():
    """Test that all required files exist"""
    base_path = Path(__file__).parent

    required_files = [
        "app.py",
        "config.py",
        "requirements.txt",
        "Dockerfile",
        ".env.example",
        ".gitignore",
        "README.md",
        "proto/__init__.py",
        "proto/lambda_action.proto",
        "services/__init__.py",
        "services/lambda_service.py",
        "services/grpc_handler.py",
    ]

    missing = []
    for file_path in required_files:
        full_path = base_path / file_path
        if not full_path.exists():
            missing.append(file_path)
        else:
            print(f"✓ {file_path}")

    if missing:
        print("\n❌ Missing files:")
        for file_path in missing:
            print(f"  - {file_path}")
        return False

    print("\n✓ All required files present")
    return True


def test_imports():
    """Test that Python files have valid syntax"""
    print("\nTesting Python imports...")

    try:
        import config
        print("✓ config.py imports successfully")

        from services import LambdaService
        print("✓ services/lambda_service.py imports successfully")

        from services import LambdaActionServicer
        print("✓ services/grpc_handler.py imports successfully")

        print("\n✓ All imports successful")
        return True

    except Exception as e:
        print(f"\n❌ Import error: {e}")
        return False


if __name__ == "__main__":
    structure_ok = test_structure()
    print("\n" + "=" * 60)

    if structure_ok:
        print("✓ Structure validation passed")
        sys.exit(0)
    else:
        print("❌ Structure validation failed")
        sys.exit(1)
