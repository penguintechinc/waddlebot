#!/bin/bash
# Update all Dockerfiles to use standardized healthcheck.py script

set -e

echo "Updating Dockerfiles to use standardized healthcheck.py..."

# Find all Dockerfiles with HEALTHCHECK commands using urllib
find . -name "Dockerfile" -type f | while read dockerfile; do
    if grep -q "HEALTHCHECK.*urllib.request.urlopen" "$dockerfile"; then
        echo "Processing: $dockerfile"

        # Check if it already has the healthcheck.py copy
        if ! grep -q "COPY scripts/healthcheck.py" "$dockerfile"; then
            # Extract the health check URL
            port=$(grep -oP "localhost:\K\d+" "$dockerfile" | head -1)
            if [ -z "$port" ]; then
                echo "  ⚠️  Warning: Could not extract port from $dockerfile"
                continue
            fi

            # Add healthcheck.py copy before "Create non-root user" or before HEALTHCHECK
            if grep -q "# Create non-root user" "$dockerfile"; then
                # Insert before "Create non-root user"
                sed -i "/# Create non-root user/i\\
# Copy standard healthcheck script\\
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py\\
RUN chmod +x /usr/local/bin/healthcheck.py\\
" "$dockerfile"
            elif grep -q "HEALTHCHECK" "$dockerfile"; then
                # Insert before HEALTHCHECK
                sed -i "/HEALTHCHECK/i\\
# Copy standard healthcheck script\\
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py\\
RUN chmod +x /usr/local/bin/healthcheck.py\\
" "$dockerfile"
            fi

            # Replace the HEALTHCHECK command (using /healthz for Kubernetes compatibility)
            sed -i "s|CMD python3 -c \"import urllib.request; urllib.request.urlopen('http://localhost:${port}/health')\"|CMD python3 /usr/local/bin/healthcheck.py http://localhost:${port}/healthz|g" "$dockerfile"

            echo "  ✓ Updated healthcheck to use standardized script with /healthz endpoint"
        else
            echo "  ✓ Already using standardized healthcheck.py"
        fi
    fi
done

echo ""
echo "✓ All Dockerfiles updated!"
