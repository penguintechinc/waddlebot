#!/usr/bin/env python3
"""
Update all Dockerfiles to use the correct build context pattern
Build from repo root with access to libs/flask_core
"""

from pathlib import Path

DOCKERFILE_TEMPLATE = """# Build from parent directory: docker build -f {module}/Dockerfile -t waddlebot/{name}:latest .

FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY {module}/requirements.txt /app/
COPY {module} /app/

# Install module dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Expose port
EXPOSE {port}

# Run with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:{port}", "--workers", "4"]
"""

# Module configurations (module_name, port)
MODULES = [
    ('router_module_flask', 8000),
    ('marketplace_module_flask', 8001),
    ('portal_module_flask', 8080),
    ('twitch_module_flask', 8002),
    ('discord_module_flask', 8003),
    ('slack_module_flask', 8004),
    ('ai_interaction_module_flask', 8005),
    ('alias_interaction_module_flask', 8010),
    ('shoutout_interaction_module_flask', 8011),
    ('inventory_interaction_module_flask', 8024),
    ('calendar_interaction_module_flask', 8030),
    ('memories_interaction_module_flask', 8031),
    ('youtube_music_interaction_module_flask', 8025),
    ('spotify_interaction_module_flask', 8026),
    ('labels_core_module_flask', 8023),
    ('browser_source_core_module_flask', 8027),
    ('identity_core_module_flask', 8050),
    ('community_module_flask', 8020),
    ('reputation_module_flask', 8021),
]

def fix_dockerfile(module, port):
    """Update Dockerfile for a module"""
    dockerfile = Path(module) / 'Dockerfile'
    name = module.replace('_module_flask', '').replace('_flask', '').replace('_', '-')

    content = DOCKERFILE_TEMPLATE.format(module=module, name=name, port=port)

    with open(dockerfile, 'w') as f:
        f.write(content)

    print(f"✅ Updated {module}/Dockerfile")

if __name__ == '__main__':
    print("Updating all Dockerfiles to use correct build context...")
    print("")

    for module, port in MODULES:
        if Path(module).exists():
            fix_dockerfile(module, port)
        else:
            print(f"❌ Module not found: {module}")

    print("")
    print("Done! All Dockerfiles updated.")
