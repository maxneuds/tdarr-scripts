#!/bin/bash
INPUT_FILE="data/test3.mkv"
OUTPUT_FILE="${INPUT_FILE%.*}-normalized.${INPUT_FILE##*.}"

# 1. Create dummy data directory if not exists
mkdir -p data

# 2. Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    exit 1
fi

# 3. Check input file
if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: $INPUT_FILE not found."
    echo "Please place a test MKV with surround sound in the data/ folder."
    exit 1
fi

echo "--- Installing Dependencies (None required, using standard Node libs) ---"

# 4. Run the JS Script
echo "--- Running Normalizer Script ---"
node stereo_normalizer.js "$INPUT_FILE" "$OUTPUT_FILE"
