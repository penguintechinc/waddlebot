#!/bin/bash
# Pre-pull models to avoid first-request delays

set -e

echo "Pulling tinyllama model..."
curl -s http://${OLLAMA_HOST:-ollama}:${OLLAMA_PORT:-11434}/api/pull -d '{"name":"tinyllama"}' || true

echo "Pulling nomic-embed-text for embeddings..."
curl -s http://${OLLAMA_HOST:-ollama}:${OLLAMA_PORT:-11434}/api/pull -d '{"name":"nomic-embed-text"}' || true

echo "Models ready."
