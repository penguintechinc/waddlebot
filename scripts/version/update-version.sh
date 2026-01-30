#!/bin/bash
# Version Management Script
# Format: vMajor.Minor.Patch.build (build is epoch64 timestamp)
#
# Usage:
#   ./scripts/version/update-version.sh          # Increment build timestamp only
#   ./scripts/version/update-version.sh patch    # Increment patch version
#   ./scripts/version/update-version.sh minor    # Increment minor version
#   ./scripts/version/update-version.sh major    # Increment major version

set -e

VERSION_FILE=".version"
UPDATE_TYPE="${1:-build}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if .version file exists
if [ ! -f "$VERSION_FILE" ]; then
    echo "Error: $VERSION_FILE not found"
    exit 1
fi

# Read current version
CURRENT_VERSION=$(cat "$VERSION_FILE")
echo -e "${BLUE}Current version:${NC} $CURRENT_VERSION"

# Parse version components
# Handle both "1.2.3" and "1.2.3.1234567890" formats
IFS='.' read -r MAJOR MINOR PATCH BUILD <<< "$CURRENT_VERSION"

# Default build to empty if not present
BUILD=${BUILD:-}

# Get current epoch timestamp
NEW_BUILD=$(date +%s)

# Update version based on type
case "$UPDATE_TYPE" in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        echo -e "${YELLOW}Incrementing MAJOR version${NC}"
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        echo -e "${YELLOW}Incrementing MINOR version${NC}"
        ;;
    patch)
        PATCH=$((PATCH + 1))
        echo -e "${YELLOW}Incrementing PATCH version${NC}"
        ;;
    build)
        echo -e "${YELLOW}Updating BUILD timestamp${NC}"
        ;;
    *)
        echo "Error: Invalid update type. Use: major, minor, patch, or build (default)"
        exit 1
        ;;
esac

# Create new version string
if [ "$UPDATE_TYPE" = "build" ] && [ -z "$BUILD" ]; then
    # If current version has no build timestamp and we're only updating build,
    # keep it simple (don't add build component)
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
else
    # Include build timestamp
    NEW_VERSION="$MAJOR.$MINOR.$PATCH.$NEW_BUILD"
fi

# Write new version
echo "$NEW_VERSION" > "$VERSION_FILE"

echo -e "${GREEN}New version:${NC} $NEW_VERSION"
echo ""
echo -e "${GREEN}✓${NC} Version updated in $VERSION_FILE"

# Show what changed
if [ "$UPDATE_TYPE" != "build" ]; then
    echo ""
    echo "Version change:"
    echo "  $CURRENT_VERSION → $NEW_VERSION"
fi
