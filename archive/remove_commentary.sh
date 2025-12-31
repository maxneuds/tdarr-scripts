#!/bin/bash

# ==============================================================================
# Script Name: remove_commentary.sh
# Description: Scans all .mkv files in the current directory.
#              Removes audio streams containing "commentary" in their title.
#              Saves cleaned files to a "cleaned" subdirectory.
# Dependencies: mkvtoolnix (mkvmerge), jq
# ==============================================================================

# 1. Check for dependencies
if ! command -v mkvmerge &> /dev/null || ! command -v jq &> /dev/null; then
    echo "Error: This script requires 'mkvmerge' and 'jq' installed."
    exit 1
fi

# 2. Create output directory to ensure safety of original files
mkdir -p cleaned

# 3. Loop through all MKV files in the current directory
for file in *.mkv; do
    # check if file exists to avoid loop errors on empty dirs
    [ -e "$file" ] || continue

    echo "Processing: $file"

    # Get file structure in JSON format
    json_info=$(mkvmerge -J "$file")

    # Extract IDs of audio tracks that DO NOT contain "commentary" (case-insensitive)
    # logic: select type audio -> select name doesn't match 'commentary' -> get ID
    keep_audio_ids=$(echo "$json_info" | jq -r '
        .tracks[] 
        | select(.type=="audio") 
        | select((.properties.track_name // "") | test("commentary"; "i") | not) 
        | .id
    ')

    # Extract IDs of ALL audio tracks (to compare)
    all_audio_ids=$(echo "$json_info" | jq -r '.tracks[] | select(.type=="audio") | .id')

    # Convert new-line separated IDs to comma separated for mkvmerge argument
    keep_str=$(echo "$keep_audio_ids" | paste -sd "," -)
    all_str=$(echo "$all_audio_ids" | paste -sd "," -)

    # 4. Determine action
    if [ "$keep_str" == "$all_str" ]; then
        echo "  [INFO] No commentary tracks found. Skipping."
    else
        echo "  [ACTION] Commentary found. Creating cleaned version..."
        
        # specific args setup: if keep list is empty, use --no-audio
        if [ -z "$keep_str" ]; then
            track_args="--no-audio"
            echo "  [WARN] All audio tracks were commentary. Removing ALL audio."
        else
            track_args="--audio-tracks $keep_str"
        fi

        # Run mkvmerge
        # We implicitly keep all video/subtitles by NOT specifying flags for them.
        # We only filter the audio using --audio-tracks.
        mkvmerge -o "cleaned/$file" $track_args "$file" > /dev/null

        if [ $? -eq 0 ]; then
            echo "  [SUCCESS] Saved to cleaned/$file"
        else
            echo "  [ERROR] Failed to process $file"
        fi
    fi
    echo "---------------------------------------------------"
done
