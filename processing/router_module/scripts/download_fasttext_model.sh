#!/bin/bash
# Download fastText language identification model
# Model: lid.176.bin (~130MB) - supports 176 languages
# Source: Facebook AI Research

set -e

MODEL_DIR="${1:-/app/models}"
MODEL_FILE="lid.176.bin"
MODEL_URL="https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin"

echo "=== FastText Language Model Downloader ==="
echo "Target directory: $MODEL_DIR"

# Create directory if it doesn't exist
mkdir -p "$MODEL_DIR"

# Check if model already exists
if [ -f "$MODEL_DIR/$MODEL_FILE" ]; then
    echo "Model already exists at $MODEL_DIR/$MODEL_FILE"
    echo "Size: $(du -h "$MODEL_DIR/$MODEL_FILE" | cut -f1)"
    exit 0
fi

echo "Downloading fastText language model..."
echo "URL: $MODEL_URL"
echo "This may take a few minutes (~130MB)..."

# Download with progress
if command -v wget &> /dev/null; then
    wget -O "$MODEL_DIR/$MODEL_FILE" "$MODEL_URL"
elif command -v curl &> /dev/null; then
    curl -L -o "$MODEL_DIR/$MODEL_FILE" "$MODEL_URL"
else
    echo "Error: Neither wget nor curl is available"
    exit 1
fi

echo ""
echo "Download complete!"
echo "Model saved to: $MODEL_DIR/$MODEL_FILE"
echo "Size: $(du -h "$MODEL_DIR/$MODEL_FILE" | cut -f1)"
