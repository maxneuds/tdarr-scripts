# Tdarr Master Media Processor (JS)

A "Grand Unified" Tdarr plugin that replaces complex node chains with a single, intelligent JavaScript processor. It offers "Vim-mode" precision control over FFmpeg, bypassing Tdarr's default stream mapping logic to prevent conflicts and ensure standardized output.

## Features

* **Zero-Conflict FFmpeg Generation:** Uses a "Dummy Object" trick (`tdarr_bypass=true`) to suppress Tdarr's automatic stream mapping, giving the script 100% control over the command line.
* **Smart Audio Curation:**
    * Auto-detects "Best" German audio (highest channel count).
    * Normalizes all audio to **Opus** (160k-448k depending on channels).
    * Sanitizes track titles (e.g., "GER 5.1ch").
* **Intelligent Subtitles:**
    * **Deduplication:** Automatically removes SRT tracks if an equivalent PGS (Image-based) track exists.
    * **Logic-Based Defaults:**
        * *Anime (JPN Audio):* Defaults to English Subtitles.
        * *Standard (GER/ENG Audio):* Disables full subtitles, enables Forced subtitles only.
* **Content-Aware Encoding:**
    * **Resolution:** Dynamic SVT-AV1 CRF (28 for 4K, 25 for 1080p, 32 for SD).
    * **Type:** Detects Animation (path keywords) to apply `hqdn3d` denoise; uses Film Grain Synthesis for live action.
* **Audio-Only Fallback:** Supports a `transcodeVideo: "false"` flow variable to skip video encoding while still cleaning audio/metadata.

## Usage

1.  **Add Plugin:** Create a "Custom Function" node in Tdarr.
2.  **Paste Code:** Use the `master-media-processor.js` content.
3.  **Flow Setup:**
    * **Input:** File Source.
    * **Logic:** (Optional) Set `transcodeVideo` variable.
    * **Processor:** This Master Node.
    * **Output:** `ffmpegCommandCustomArguments` node set to `{{{args.variables.ffmpegMasterCommand}}}`.
    * **Execute:** Standard `ffmpegCommandExecute` (Ensure "Map all streams" is OFF).