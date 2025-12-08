#!/bin/bash
# Capture screenshots from inside Docker network where hub is accessible

set -e

echo "Creating screenshots directory..."
mkdir -p docs/screenshots

echo "Running screenshot capture via Docker network..."
docker run --rm \
  --network waddlebot_default \
  -v "$(pwd)/scripts/capture-screenshots.cjs:/app/capture.cjs" \
  -v "$(pwd)/docs/screenshots:/app/screenshots" \
  -w /app \
  node:18-slim \
  bash -c "
    npm install -g puppeteer &&
    # Update script to use correct URL and output dir
    sed -i 's|http://localhost:8060|http://hub:8060|g' /app/capture.cjs &&
    sed -i 's|path.join(__dirname, '\''../'\'', '\''docs'\'', '\''screenshots'\'')|'\''/app/screenshots'\''|g' /app/capture.cjs &&
    node /app/capture.cjs
  "

echo ""
echo "✓ Screenshots saved to docs/screenshots/"
ls -lh docs/screenshots/
