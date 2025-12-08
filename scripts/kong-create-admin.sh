#!/bin/bash
# Create Kong admin user for RBAC authentication

set -e

ADMIN_USERNAME="${KONG_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${KONG_ADMIN_PASSWORD:-admin_password_change_me}"

echo "Creating Kong admin user for RBAC..."
echo ""

# Wait for Kong to be ready
echo "Waiting for Kong Admin API..."
until curl -s http://localhost:8001/status > /dev/null 2>&1; do
  echo -n "."
  sleep 2
done
echo ""
echo "✓ Kong Admin API is ready"
echo ""

# Create super admin user
echo "Creating RBAC user: $ADMIN_USERNAME"
USER_TOKEN=$(openssl rand -base64 32)

curl -s -X POST http://localhost:8001/rbac/users \
  --data "name=$ADMIN_USERNAME" \
  --data "user_token=$USER_TOKEN" > /dev/null

# Get user ID
USER_ID=$(curl -s http://localhost:8001/rbac/users | jq -r ".data[] | select(.name==\"$ADMIN_USERNAME\") | .id")

# Assign super-admin role
echo "Assigning super-admin role..."
curl -s -X POST "http://localhost:8001/rbac/users/$USER_ID/roles" \
  --data "roles=super-admin" > /dev/null

echo ""
echo "✓ Admin user '$ADMIN_USERNAME' created successfully"
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Kong Manager Login Information"
echo "═══════════════════════════════════════════════════"
echo "  URL: http://localhost:8002/manager"
echo "  Username: $ADMIN_USERNAME"
echo "  Password: $ADMIN_PASSWORD"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Note: Change these credentials in production!"
