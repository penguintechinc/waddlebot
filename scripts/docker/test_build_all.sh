#!/bin/bash
# WaddleBot Container Build Test Script
# Replicates GitHub Actions workflow build process
# Usage: ./scripts/docker/test_build_all.sh

set -e

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                                                                              ║"
echo "║              WaddleBot Module - Container Build Test                         ║"
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

# Function to build a module (no runtime tests - those need full infrastructure)
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
        PASSED=$((PASSED + 1))
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

test_module "router_module" "router" 8000
test_module "marketplace_module" "marketplace" 8001
test_module "hub_module" "hub" 8060

# Collector Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "COLLECTOR MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "twitch_module" "twitch-collector" 8002
test_module "discord_module" "discord-collector" 8003
test_module "slack_module" "slack-collector" 8004

# Interaction Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "INTERACTION MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "ai_interaction_module" "ai-interaction" 8005
test_module "alias_interaction_module" "alias-interaction" 8010
test_module "shoutout_interaction_module" "shoutout-interaction" 8011
test_module "inventory_interaction_module" "inventory-interaction" 8024
test_module "calendar_interaction_module" "calendar-interaction" 8030
test_module "memories_interaction_module" "memories-interaction" 8031
test_module "youtube_music_interaction_module" "youtube-music" 8025
test_module "spotify_interaction_module" "spotify-interaction" 8026

# Core System Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "CORE SYSTEM MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "labels_core_module" "labels-core" 8023
test_module "browser_source_core_module" "browser-source" 8027
test_module "identity_core_module" "identity-core" 8050

# Supporting Modules
echo ""
echo "══════════════════════════════════════════════════════════════════════════════"
echo "SUPPORTING MODULES"
echo "══════════════════════════════════════════════════════════════════════════════"

test_module "community_module" "community" 8020
test_module "reputation_module" "reputation" 8021

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
