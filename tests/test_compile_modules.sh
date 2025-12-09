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

# Test all module directories (without _flask suffix - renamed)
for module in ai_interaction_module alias_interaction_module browser_source_core_module calendar_interaction_module community_module discord_module identity_core_module inventory_interaction_module labels_core_module marketplace_module memories_interaction_module portal_module reputation_module router_module shoutout_interaction_module slack_module spotify_interaction_module twitch_module youtube_music_interaction_module hub_module/backend; do
    echo ""
    echo "Testing $module..."
    find $module -name "*.py" -type f 2>/dev/null | while read f; do
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
