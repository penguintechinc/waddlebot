#!/bin/bash
# WaddleBot Container Build Test Script
# Replicates GitHub Actions workflow build process
# Usage: ./test_build_all.sh

set -e

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                                                                              ║"
echo "║              WaddleBot Flask Module - Container Build Test                  ║"
echo "║                                                                              ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track results
TOTAL=0
PASSED=0
FAILED=0

# Function to build and test a module
test_module() {
    local module=$1
    local name=$2
    local port=$3

    TOTAL=$((TOTAL + 1))
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${YELLOW}Testing $name (${module})${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Build image (matching GitHub Actions workflow pattern)
    echo "📦 Building Docker image..."
    if docker build \
        -f ${module}/Dockerfile \
        -t waddlebot/${name}:test \
        --build-arg MODULE_NAME=${name} \
        --build-arg MODULE_PORT=${port} \
        . > /tmp/build_${name}.log 2>&1; then
        echo -e "${GREEN}✅ Build successful${NC}"

        # Test the image
        echo "🧪 Starting container for testing..."
        if docker run --rm --name test-${name} -d -p ${port}:${port} waddlebot/${name}:test > /dev/null 2>&1; then
            echo "⏳ Waiting for service to start..."
            sleep 10

            # Health check
            echo "🏥 Running health check..."
            if curl -f http://localhost:${port}/health > /dev/null 2>&1; then
                echo -e "${GREEN}✅ Health check passed${NC}"
                PASSED=$((PASSED + 1))
            else
                echo -e "${RED}❌ Health check failed${NC}"
                FAILED=$((FAILED + 1))
            fi

            # Stop container
            echo "🛑 Stopping container..."
            docker stop test-${name} > /dev/null 2>&1
        else
            echo -e "${RED}❌ Container failed to start${NC}"
            FAILED=$((FAILED + 1))
        fi
    else
        echo -e "${RED}❌ Build failed${NC}"
        echo "Build log:"
        tail -50 /tmp/build_${name}.log
        FAILED=$((FAILED + 1))
    fi
}

echo "Starting container build tests..."
echo "This replicates the GitHub Actions workflow build process"
echo ""

# Core Modules
echo "══════════════════════════════════════════════════════════════════════════════"
echo "CORE MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "router_module_flask" "router" 8000
test_module "marketplace_module_flask" "marketplace" 8001
test_module "portal_module_flask" "portal" 8080

# Collector Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "COLLECTOR MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "twitch_module_flask" "twitch-collector" 8002
test_module "discord_module_flask" "discord-collector" 8003
test_module "slack_module_flask" "slack-collector" 8004

# Interaction Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "INTERACTION MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "ai_interaction_module_flask" "ai-interaction" 8005
test_module "alias_interaction_module_flask" "alias-interaction" 8010
test_module "shoutout_interaction_module_flask" "shoutout-interaction" 8011
test_module "inventory_interaction_module_flask" "inventory-interaction" 8024
test_module "calendar_interaction_module_flask" "calendar-interaction" 8030
test_module "memories_interaction_module_flask" "memories-interaction" 8031
test_module "youtube_music_interaction_module_flask" "youtube-music" 8025
test_module "spotify_interaction_module_flask" "spotify-interaction" 8026

# Core System Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "CORE SYSTEM MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "labels_core_module_flask" "labels-core" 8023
test_module "browser_source_core_module_flask" "browser-source" 8027
test_module "identity_core_module_flask" "identity-core" 8050

# Supporting Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "SUPPORTING MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "community_module_flask" "community" 8020
test_module "reputation_module_flask" "reputation" 8021

# Summary
echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                          BUILD TEST SUMMARY                                  ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Modules Tested: $TOTAL"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All container builds passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some container builds failed${NC}"
    exit 1
fi
