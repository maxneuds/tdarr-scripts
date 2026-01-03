#!/bin/bash

# Create a directory for the new files to avoid overwriting originals
mkdir -p merged

# Loop through all .mkv files in the current directory
for video in *.mkv; do
    # Extract the filename without the extension (e.g., "School Rumble Ep 01...")
    base="${video%.*}"

    # Check if the corresponding .idx file exists
    # mkvmerge reads the .sub file automatically if the .idx is present
    if [[ -f "$base.idx" ]]; then
        echo "Found subtitles for: $video. Merging..."

        # The command breakdown:
        # -o "merged/$video" : Output the new file to the 'merged' folder
        # "$video"           : The original video file input
        # --language 0:ger   : Force the language of the first track (0) in the next input file to German
        # "$base.idx"        : The subtitle index file input
        
        mkvmerge -o "merged/$video" "$video" --language 0:ger "$base.idx"
        
        if [ $? -eq 0 ]; then
            echo "Successfully merged: $video"
            echo "---------------------------------------------------"
        else
            echo "Error processing: $video"
        fi
    else
        echo "No matching .idx file found for: $video. Skipping."
    fi
done
