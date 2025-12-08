#!/bin/bash
# Migrate declarative Kong config from YAML to database
# Uses decK (Kong's declarative configuration tool)

set -e

echo "Migrating Kong configuration from declarative YAML to database..."
echo ""

# Check if decK is installed
if ! command -v deck &> /dev/null; then
  echo "decK not found. Installing..."
  echo ""

  # Download and install deck
  DECK_VERSION="1.28.2"
  DECK_URL="https://github.com/kong/deck/releases/download/v${DECK_VERSION}/deck_${DECK_VERSION}_linux_amd64.tar.gz"

  curl -sL "$DECK_URL" | tar xz
  sudo mv deck /usr/local/bin/
  sudo chmod +x /usr/local/bin/deck

  echo "✓ decK v${DECK_VERSION} installed"
  echo ""
fi

# Wait for Kong to be ready
echo "Waiting for Kong Admin API..."
until curl -s http://localhost:8001/status > /dev/null 2>&1; do
  echo -n "."
  sleep 2
done
echo ""
echo "✓ Kong Admin API is ready"
echo ""

# Sync declarative config to database
echo "Syncing configuration from config/kong/kong.yml..."
deck sync --kong-addr http://localhost:8001 --state config/kong/kong.yml

echo ""
echo "✓ Configuration migrated successfully"
echo ""
echo "All services, routes, plugins, and consumers have been"
echo "imported from kong.yml into the Kong database."
echo ""
echo "You can now manage Kong via Kong Manager at:"
echo "  http://localhost:8002/manager"
