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

# Test all module directories
for module in ai_interaction_module_flask alias_interaction_module_flask browser_source_core_module_flask calendar_interaction_module_flask community_module_flask discord_module_flask identity_core_module_flask inventory_interaction_module_flask labels_core_module_flask marketplace_module_flask memories_interaction_module_flask portal_module_flask reputation_module_flask router_module_flask shoutout_interaction_module_flask slack_module_flask spotify_interaction_module_flask twitch_module_flask youtube_music_interaction_module_flask; do
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
