#!/bin/sh
# Redis ACL Entrypoint Script
# Substitutes environment variables in the ACL file before starting Redis

set -e

ACL_TEMPLATE="/etc/redis/users.acl.template"
ACL_FILE="/etc/redis/users.acl"

echo "Generating Redis ACL file from template..."

# Copy template and substitute environment variables
cp "$ACL_TEMPLATE" "$ACL_FILE"

# Substitute each password placeholder with actual environment variable
# Using default passwords if not set (for development only!)
sed -i "s/REDIS_ADMIN_PASSWORD_PLACEHOLDER/${REDIS_ADMIN_PASSWORD:-waddlebot_admin_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_ROUTER_PASSWORD_PLACEHOLDER/${REDIS_ROUTER_PASSWORD:-waddlebot_router_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_HUB_PASSWORD_PLACEHOLDER/${REDIS_HUB_PASSWORD:-waddlebot_hub_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_WORKFLOW_PASSWORD_PLACEHOLDER/${REDIS_WORKFLOW_PASSWORD:-waddlebot_workflow_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_AI_PASSWORD_PLACEHOLDER/${REDIS_AI_PASSWORD:-waddlebot_ai_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_ANALYTICS_PASSWORD_PLACEHOLDER/${REDIS_ANALYTICS_PASSWORD:-waddlebot_analytics_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_SECURITY_PASSWORD_PLACEHOLDER/${REDIS_SECURITY_PASSWORD:-waddlebot_security_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_LOYALTY_PASSWORD_PLACEHOLDER/${REDIS_LOYALTY_PASSWORD:-waddlebot_loyalty_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_SPOTIFY_PASSWORD_PLACEHOLDER/${REDIS_SPOTIFY_PASSWORD:-waddlebot_spotify_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_YTMUSIC_PASSWORD_PLACEHOLDER/${REDIS_YTMUSIC_PASSWORD:-waddlebot_ytmusic_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_TWITCH_PASSWORD_PLACEHOLDER/${REDIS_TWITCH_PASSWORD:-waddlebot_twitch_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_DISCORD_PASSWORD_PLACEHOLDER/${REDIS_DISCORD_PASSWORD:-waddlebot_discord_dev}/g" "$ACL_FILE"
sed -i "s/REDIS_SLACK_PASSWORD_PLACEHOLDER/${REDIS_SLACK_PASSWORD:-waddlebot_slack_dev}/g" "$ACL_FILE"

echo "ACL file generated successfully."
echo "Configured users:"
grep "^user " "$ACL_FILE" | awk '{print "  - " $2}'

# Start Redis with the configuration
exec redis-server /etc/redis/redis.conf "$@"
