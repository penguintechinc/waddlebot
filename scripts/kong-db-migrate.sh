#!/bin/bash
# Run Kong database migrations
# This script bootstraps Kong's database schema

set -e

echo "Running Kong database migrations..."
echo ""

# Check if PostgreSQL is accessible
echo "Checking PostgreSQL connectivity..."
until docker exec waddlebot-postgres pg_isready -U waddlebot > /dev/null 2>&1; do
  echo "Waiting for PostgreSQL..."
  sleep 2
done
echo "✓ PostgreSQL is ready"
echo ""

# Run Kong migrations
echo "Bootstrapping Kong database schema..."
docker-compose run --rm kong kong migrations bootstrap

echo ""
echo "✓ Kong database migrations completed successfully"
echo ""
echo "Next steps:"
echo "  1. Start Kong: docker-compose up -d kong"
echo "  2. Migrate configuration: ./scripts/migrate-kong-config.sh"
echo "  3. Create admin user: ./scripts/kong-create-admin.sh"
