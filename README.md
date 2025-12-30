Here is the updated README documentation tailored specifically for **v3.3**, focusing on the new audio curation, subtitle renaming, and deduplication features.

---

# Tdarr Master Media Processor (v3.3)

A "Grand Unified" Tdarr plugin designed to replace complex, multi-node flows with a single, intelligent JavaScript processor. This script provides **"Vim-mode" precision control** over FFmpeg, bypassing Tdarr's default stream mapping logic to prevent conflicts, standardize metadata, and curate tracks intelligently.

## 🚀 Key Features

### 1. Zero-Conflict "Ghost" Protocol

* **The Problem:** Tdarr's default behavior often auto-injects `-c copy` or duplicate maps for streams it thinks are unhandled, corrupting complex custom commands.
* **The Solution:** This script uses a "Full Ghost" object strategy. It clones the file's stream list for Tdarr's internal safety checks but marks them as `removed`, forcing Tdarr to generate **zero** flags. The script then injects the *actual* FFmpeg command string manually.

### 2. Audio Curation & Normalization

* **German Priority:** Automatically scans for German audio tracks. If multiple exist, it selects the "Best" track based on channel count (e.g., 5.1 beats Stereo) and sets it as `Default`.
* **Smart Transcoding:**
* **Opus:** Converts track to Opus.
* **Bitrate Logic:** 96k (Mono), 160k (Stereo), 320k (5.1), 448k (7.1).
* **Passthrough:** If the source is already Opus, it copies the stream.


* **Metadata:** Sanitizes track titles to a clean standard (e.g., `GER 5.1ch`) and explicitly sets the `language` tag.

### 3. Intelligent Subtitle Management

* **Deduplication:** Automatically detects if a movie has the same subtitle (e.g., "German Forced") in both **PGS** (Image) and **SRT** (Text) formats. It **removes the SRT** version to reduce clutter, preferring the higher-quality PGS.
* **Standardized Renaming:** Renames tracks using a strict naming convention with **Non-Breaking Spaces** (`\u00A0`) to prevent command line errors:
* `GER Forced`
* `ENG Full`


* **Smart Defaults:**
* **Forced Priority:** Forced subtitles (German > English) are always set to `Default`.
* **Anime Rule:** If the active audio is **Japanese**, the script defaults to **English** subtitles.
* **Clean Playback:** If the active audio is German or English, full subtitles are disabled by default.



### 4. Content-Aware Video Encoding

* **Resolution Detection:** Automatically adjusts SVT-AV1 **CRF** based on pixel count:
* **4K:** CRF 28
* **2K:** CRF 26
* **1080p:** CRF 25
* **SD:** CRF 32


* **Type Detection:** Scans the filepath for keywords (`anime`, `cartoon`, `animation`).
* **Animation:** Uses `hqdn3d` (strong denoise, cleaner lines).
* **Live Action:** Uses Film Grain Synthesis (preserves texture).



### 5. Audio-Only Fallback

Supports a Flow Variable `transcodeVideo`.

* If set to `"false"`, the script **Copies** the video stream (`-c:v copy`) bit-for-bit.
* It *still* performs all Audio Curation, Subtitle Cleaning, and Metadata standardization.

---

## 🛠️ Installation & Usage

1. **Create Plugin:** In Tdarr, create a new **Local Plugin** (type: JS / Custom Function).
2. **Paste Code:** Copy the contents of `master-media-processor.js` into the code editor.
3. **Flow Setup:**
* **Node 1:** `Input File`
* **Node 2 (Optional):** `Set Flow Variable` (Name: `transcodeVideo`, Value: `false`) *<-- Only if you want to skip video encoding.*
* **Node 3:** `JS: Master Media Processor` (This plugin).
* **Node 4:** `ffmpegCommandCustomArguments`.
* **Value:** `-probesize 30M -analyzeduration 30M {{{args.variables.ffmpegMasterCommand}}}`


* **Node 5:** `ffmpegCommandExecute`.
* **Critical:** Go to this node's options and ensure **"Enable map all streams" is UNCHECKED**.


---

## 🔍 Technical Details

### The `tdarr_bypass` Tag

You may notice a global metadata tag `-metadata tdarr_bypass=true` in the generated command. This is a harmless "dummy argument" injected into the Tdarr object to satisfy Tdarr's requirement that at least one stream must be processed, preventing the "No streams mapped" error while keeping Tdarr's auto-logic disabled.

### Conditional Attachments

The script checks for the existence of fonts/attachments before attempting to map them. This prevents `Stream specifier t does not match any streams` errors on files that do not contain embedded fonts (common in non-Anime content).