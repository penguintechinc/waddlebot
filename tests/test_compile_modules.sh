#!/bin/bash

echo "=== Comprehensive Module Compile Test ==="
echo ""

# Test libs/flask_core
echo "Testing libs/flask_core..."
find libs/flask_core -name "*.py" -type f | while read f; do
    python3 -m py_compile "$f" 2>&1
    if [ $? -eq 0 ]; then
        echo "  ✓ $f"
    else
        echo "  ✗ $f FAILED"
    fi
done

# Test all module directories with correct paths
MODULES=(
    # Action modules - Interactive
    "action/interactive/ai_interaction_module"
    "action/interactive/alias_interaction_module"
    "action/interactive/calendar_interaction_module"
    "action/interactive/inventory_interaction_module"
    "action/interactive/loyalty_interaction_module"
    "action/interactive/memories_interaction_module"
    "action/interactive/quote_interaction_module"
    "action/interactive/shoutout_interaction_module"
    "action/interactive/spotify_interaction_module"
    "action/interactive/youtube_music_interaction_module"
    # Action modules - Pushing
    "action/pushing/discord_action_module"
    "action/pushing/gcp_functions_action_module"
    "action/pushing/lambda_action_module"
    "action/pushing/openwhisk_action_module"
    "action/pushing/slack_action_module"
    "action/pushing/twitch_action_module"
    "action/pushing/youtube_action_module"
    # Core modules
    "core/ai_researcher_module"
    "core/analytics_core_module"
    "core/browser_source_core_module"
    "core/community_module"
    "core/identity_core_module"
    "core/labels_core_module"
    "core/reputation_module"
    "core/security_core_module"
    "core/unified_music_module"
    "core/workflow_core_module"
    # Processing module
    "processing/router_module"
    # Trigger modules - Receiver
    "trigger/receiver/discord_module"
    "trigger/receiver/kick_module_flask"
    "trigger/receiver/slack_module"
    "trigger/receiver/twitch_module"
    "trigger/receiver/youtube_live_module"
    # Admin modules
    "admin/hub_module/backend"
    "admin/marketplace_module"
)

for module in "${MODULES[@]}"; do
    echo ""
    echo "Testing $module..."
    find "$module" -name "*.py" -type f 2>/dev/null | while read f; do
        python3 -m py_compile "$f" 2>&1
        if [ $? -eq 0 ]; then
            echo "  ✓ $f"
        else
            echo "  ✗ $f FAILED"
        fi
    done
done

echo ""
echo "=== Compile Test Complete ==="
