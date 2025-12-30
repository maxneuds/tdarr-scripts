#!/bin/bash

# FAIL-SAFE: Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "Error: FFmpeg is not installed or not in your PATH."
    exit 1
fi

# Create output folder
mkdir -p fixed

# Loop through all mkv files
for file in *.mkv; do
    [ -e "$file" ] || continue
    
    echo "------------------------------------------------"
    echo "Processing: $file"
    
    # FFmpeg Command
    ffmpeg -v error -stats -y -i "$file" \
    -map 0 \
    -map -0:a:1 \
    -map -0:s:1 \
    -c copy \
    -metadata:s:a:1 language=jpn \
    -metadata:s:s:0 title="GER Forced" \
    -disposition:s:0 default+forced \
    "fixed/$file"
    
    if [ $? -eq 0 ]; then
        echo "Successfully processed: $file"
    else
        echo "ERROR processing: $file"
    fi
done

echo "------------------------------------------------"
echo "Done! Check the 'fixed' folder."
