#!/usr/bin/env python3
"""
Fix requirements.txt in all Flask modules to remove editable install reference
The editable install of flask_core is handled in the Dockerfile instead
"""

import os
from pathlib import Path

# Base requirements template (without editable flask_core)
BASE_REQUIREMENTS = """# WaddleBot Flask Module - Dependencies

# Core Framework
quart>=0.19.0
hypercorn>=0.16.0

# HTTP Client (async)
httpx>=0.26.0

# Environment
python-dotenv>=1.0.0

# Development
pytest>=7.4.0
pytest-asyncio>=0.23.0
pytest-cov>=4.1.0
"""

# Modules to fix
MODULES = [
    'router_module_flask',
    'marketplace_module_flask',
    'portal_module_flask',
    'twitch_module_flask',
    'discord_module_flask',
    'slack_module_flask',
    'ai_interaction_module_flask',
    'alias_interaction_module_flask',
    'shoutout_interaction_module_flask',
    'inventory_interaction_module_flask',
    'calendar_interaction_module_flask',
    'memories_interaction_module_flask',
    'youtube_music_interaction_module_flask',
    'spotify_interaction_module_flask',
    'labels_core_module_flask',
    'browser_source_core_module_flask',
    'identity_core_module_flask',
    'community_module_flask',
    'reputation_module_flask',
]

def fix_requirements():
    """Fix requirements.txt in all modules"""
    for module in MODULES:
        req_file = Path(module) / 'requirements.txt'
        if req_file.exists():
            # Read existing file
            with open(req_file, 'r') as f:
                content = f.read()

            # Check if it has the editable install
            if '-e ../libs/flask_core' in content:
                print(f"✅ Fixed {module}/requirements.txt")
                with open(req_file, 'w') as f:
                    f.write(BASE_REQUIREMENTS)
            else:
                print(f"⏭️  Skipped {module}/requirements.txt (already correct)")
        else:
            print(f"❌ Missing {module}/requirements.txt")

if __name__ == '__main__':
    print("Fixing requirements.txt files in all Flask modules...")
    print("")
    fix_requirements()
    print("")
    print("Done!")
