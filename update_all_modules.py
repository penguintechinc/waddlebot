#!/usr/bin/env python3
"""
Update all Flask modules with:
1. /healthz and /metrics endpoints via create_health_blueprint
2. Fix common flake8 linter issues
"""

import os
import re
from pathlib import Path

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


def update_module_app(module_path: Path):
    """Update module app.py with health blueprint registration."""
    app_file = module_path / 'app.py'
    if not app_file.exists():
        print(f"  ⚠️  No app.py found in {module_path}")
        return False

    with open(app_file, 'r') as f:
        content = f.read()

    # Check if already has health blueprint
    if 'create_health_blueprint' in content:
        print(f"  ⏭️  Already has health blueprint")
        return True

    # Check if it imports from flask_core
    if 'from flask_core import' in content:
        # Add create_health_blueprint to imports
        content = re.sub(
            r'(from flask_core import[^)]+)',
            r'\1, create_health_blueprint',
            content
        )
    else:
        # Add full import
        content = content.replace(
            'from quart import',
            'from flask_core import create_health_blueprint\nfrom quart import'
        )

    # Find the Config import to get module info
    config_match = re.search(r'from config import Config', content)

    # Add health blueprint registration after app creation
    # Find the app = Quart(__name__) line
    if 'app = Quart(__name__)' in content:
        # Add health blueprint registration after app creation
        old_pattern = 'app = Quart(__name__)'
        new_code = '''app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)'''
        content = content.replace(old_pattern, new_code)

    # Remove old @app.route('/health') if exists
    content = re.sub(
        r"@app\.route\('/health'\)\nasync def health\(\):.*?return \{.*?\}, 200\n",
        '',
        content,
        flags=re.DOTALL
    )

    # Fix common flake8 issues
    # E501: Line too long - we'll leave these for now
    # E302: Expected 2 blank lines
    content = re.sub(r'\n{4,}', '\n\n\n', content)
    # E303: Too many blank lines
    content = re.sub(r'\n{3,}(?=\S)', '\n\n', content)
    # W291: Trailing whitespace
    content = re.sub(r' +\n', '\n', content)
    # W292: No newline at end of file
    if not content.endswith('\n'):
        content += '\n'
    # W293: Blank line contains whitespace
    content = re.sub(r'\n +\n', '\n\n', content)
    # E401: Multiple imports on one line
    # F401: Imported but unused - leave for now

    with open(app_file, 'w') as f:
        f.write(content)

    return True


def fix_linter_issues(file_path: Path):
    """Fix common flake8 linter issues in a Python file."""
    with open(file_path, 'r') as f:
        content = f.read()

    original = content

    # W291: Trailing whitespace
    content = re.sub(r' +\n', '\n', content)
    # W293: Blank line contains whitespace
    content = re.sub(r'\n +\n', '\n\n', content)
    # W292: No newline at end of file
    if content and not content.endswith('\n'):
        content += '\n'
    # E303: Too many blank lines (more than 2)
    content = re.sub(r'\n{4,}', '\n\n\n', content)
    # E302: Expected 2 blank lines before function/class
    content = re.sub(r'(\n)(def |class |async def )', r'\n\n\2', content)
    # But don't add extra before first function
    content = re.sub(r'\A\n+', '', content)

    if content != original:
        with open(file_path, 'w') as f:
            f.write(content)
        return True
    return False


def main():
    print("╔══════════════════════════════════════════════════════════════════════════════╗")
    print("║                                                                              ║")
    print("║        Updating All Flask Modules with Healthz/Metrics Endpoints             ║")
    print("║                                                                              ║")
    print("╚══════════════════════════════════════════════════════════════════════════════╝")
    print("")

    # Update each module
    for module in MODULES:
        module_path = Path(module)
        if not module_path.exists():
            print(f"❌ Module not found: {module}")
            continue

        print(f"📦 Processing {module}...")

        # Update app.py with health blueprint
        if update_module_app(module_path):
            print(f"  ✅ Updated app.py")

        # Fix linter issues in all Python files
        fixed_count = 0
        for py_file in module_path.rglob('*.py'):
            if fix_linter_issues(py_file):
                fixed_count += 1

        if fixed_count > 0:
            print(f"  🔧 Fixed linter issues in {fixed_count} files")

    # Also fix flask_core library
    print("")
    print("📚 Processing libs/flask_core...")
    flask_core = Path('libs/flask_core')
    fixed_count = 0
    for py_file in flask_core.rglob('*.py'):
        if fix_linter_issues(py_file):
            fixed_count += 1
    if fixed_count > 0:
        print(f"  🔧 Fixed linter issues in {fixed_count} files")

    print("")
    print("✅ All modules updated!")


if __name__ == '__main__':
    main()
