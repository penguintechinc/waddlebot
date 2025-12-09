#!/bin/bash
# Add standardized healthcheck to ALL Dockerfiles in the repository

set -e

echo "Adding standardized healthcheck to all Dockerfiles..."
echo ""

updated_count=0
skipped_count=0
added_count=0

# Find all Dockerfiles
find . -name "Dockerfile" -type f ! -path "*/node_modules/*" ! -path "*/.git/*" | while read dockerfile; do
    echo "Processing: $dockerfile"

    # Skip if already has the standardized healthcheck.py
    if grep -q "COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py" "$dockerfile"; then
        echo "  ✓ Already has standardized healthcheck"
        ((skipped_count++))
        continue
    fi

    # Detect the exposed port
    port=$(grep -oP "EXPOSE \K\d+" "$dockerfile" | head -1)
    if [ -z "$port" ]; then
        echo "  ⚠️  Warning: No EXPOSE port found, skipping"
        continue
    fi

    # Check if it has USER directive
    if ! grep -q "^USER " "$dockerfile"; then
        echo "  ⚠️  Warning: No USER directive found, adding before CMD/ENTRYPOINT"

        # Add healthcheck script and HEALTHCHECK before CMD/ENTRYPOINT
        sed -i "/^CMD\|^ENTRYPOINT/i\\
# Copy standard healthcheck script\\
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py\\
RUN chmod 755 /usr/local/bin/healthcheck.py\\
\\
# Health check (using /healthz for Kubernetes compatibility)\\
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\\\\\
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:${port}/healthz\\
" "$dockerfile"

        echo "  ✓ Added healthcheck (no USER directive pattern)"
        ((added_count++))
        continue
    fi

    # Pattern 1: Has "Create non-root user" comment
    if grep -q "# Create non-root user" "$dockerfile"; then
        sed -i "/# Create non-root user/i\\
# Copy standard healthcheck script\\
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py\\
RUN chmod 755 /usr/local/bin/healthcheck.py\\
" "$dockerfile"
    # Pattern 2: Has RUN useradd
    elif grep -q "RUN useradd" "$dockerfile"; then
        sed -i "/RUN useradd/i\\
# Copy standard healthcheck script\\
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py\\
RUN chmod 755 /usr/local/bin/healthcheck.py\\
" "$dockerfile"
    # Pattern 3: Has USER directive
    elif grep -q "^USER " "$dockerfile"; then
        sed -i "/^USER /i\\
# Copy standard healthcheck script\\
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py\\
RUN chmod 755 /usr/local/bin/healthcheck.py\\
" "$dockerfile"
    fi

    # Now add or update HEALTHCHECK
    if grep -q "HEALTHCHECK" "$dockerfile"; then
        # Update existing HEALTHCHECK
        if grep -q "urllib.request.urlopen" "$dockerfile"; then
            # Replace old-style inline Python healthcheck
            sed -i "s|CMD python3 -c \"import urllib.request; urllib.request.urlopen('http://localhost:${port}/health')\"|CMD python3 /usr/local/bin/healthcheck.py http://localhost:${port}/healthz|g" "$dockerfile"
            echo "  ✓ Updated existing HEALTHCHECK to use standardized script"
            ((updated_count++))
        else
            echo "  ⚠️  Has HEALTHCHECK but not using urllib pattern, manual review needed"
        fi
    else
        # Add new HEALTHCHECK before CMD/ENTRYPOINT
        sed -i "/^CMD\|^ENTRYPOINT/i\\
\\
# Health check (using /healthz for Kubernetes compatibility)\\
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\\\\\
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:${port}/healthz\\
" "$dockerfile"
        echo "  ✓ Added new HEALTHCHECK"
        ((added_count++))
    fi
done

echo ""
echo "=================================================="
echo "Summary:"
echo "  Updated existing: ${updated_count}"
echo "  Added new: ${added_count}"
echo "  Already standardized: ${skipped_count}"
echo "=================================================="
echo ""
echo "✓ All Dockerfiles processed!"
echo ""
echo "Next steps:"
echo "1. Review changes: git diff"
echo "2. Rebuild images: docker-compose build"
echo "3. Test deployments: docker-compose up -d"
