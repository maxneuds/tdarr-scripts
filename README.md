Here is a comprehensive `README.md` formatted for GitHub, documenting the logic, parameters, and audio engineering principles used in your scripts.

---

# Tdarr AV Automation Scripts

This repository contains two advanced Tdarr plugins designed for high-end media archival. They focus on intelligent track sorting, AV1 transcoding, and audiophile-grade stereo downmixing with dialogue normalization.

**Scripts included:**

1. **Master Media Processor v3.7** (Video Transcoding & Track Curation)
2. **Audio Normalizer v1.4** (Dynamic Downmixing & Loudness Correction)

---

## 1. Master Media Processor v3.8

A monolithic plugin designed to act as the "brain" of the encoding stack. It handles video compression (AV1), subtitle deduplication, and metadata standardization.

### 🔌 Parameters & Input Variables

The script accepts the following variable via Tdarr's library settings:

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `transcodeVideo` | String | `true` | If set to `false`, the video stream is copied (`-c:v copy`). If `true`, it triggers the SVT-AV1 logic. |

### 🧠 Logic Breakdown

#### A. Video Engine (SVT-AV1)

The script automatically detects the resolution and content type (Animation vs. Live Action) to apply specific SVT-AV1 parameters.

* **CRF targeting:**
* **4K (≥ 5MP):** CRF 27
* **2K (≥ 3MP):** CRF 26
* **1080p (≥ 1MP):** CRF 25
* **SD:** CRF 32


* **Content Detection:**
* **Animation:** Detects keywords (`anime`, `cartoon`) in the file path. Applies `hqdn3d` (High Quality 3D Denoise) to flatten flat colors and disables film grain synth.
* **Film:** Enables **Film Grain Synthesis** (`film-grain=8`) to preserve texture at lower bitrates.



#### B. Audio Curator

Prioritizes German language tracks but retains English and others based on channel count.

1. **Selection:** Finds the best German track (highest channel count).
2. **Fallback:** If no German audio exists, defaults to the original default track.
3. **Encoding:** Converts all audio to **Opus** to save space while maintaining transparency.
* `1ch` -> 96k
* `2ch` -> 160k
* `5.1` -> 320k
* `7.1` -> 448k



#### C. Subtitle Deduplication

Solves the "subtitle spam" issue.

1. **Registry:** Scans all PGS (Image-based) subtitles first.
2. **Dedupe:** If a text-based (SRT) subtitle exists with the same Language and Forced status as a PGS track, the SRT is **discarded**.
3. **Renaming:** Renames tracks to standardized titles: `GER Full`, `ENG Forced`, `ENG SDH` etc.
4. **Default Logic:**
* Priority 1: **German Forced**
* Priority 2: **English Forced**
* Priority 3: **Audio Match** (If Audio is Japanese, default to English Full).



---

## 2. Audio Normalizer v1.6

This script is a conditional processor. It **only** runs if Surround Sound (4.0, 5.1, or 7.1) is detected. It generates a new "Night Mode" stereo track alongside the original surround tracks.

### 🎛 The Audio Chain

The script utilizes a complex FFmpeg filter chain to downmix surround sound without losing dialogue clarity or bass impact.

**The Filter Chain:**
`pan` -> `dynaudnorm` -> `equalizer` -> `highpass` -> `alimiter`

1. **Smart Downmix (Pan):**
* **Center Channel (Dialogue):** Boosted to **1.0** (standard is 0.707) to ensure clear voices.
* **Surrounds:** Attenuated to **0.6** to reduce background clutter.
* **LFE (Subwoofer):** Mixed in at **1.0** to retain rumble on full-range stereo speakers.


2. **Dynamic Normalization (`dynaudnorm`):**
* Window size: `250ms` (Fast reaction time).
* Max Gain: `10dB` (Boosts whispers effectively).
* Logic: Compresses dynamic range intelligently so you don't have to ride the volume remote.


3. **Safety Filters:**
* **Highpass (20Hz):** Removes inaudible DC offset rumble.
* **Limiter (-0.9dB):** Prevents digital clipping (True Peak safety).



### 📊 Stream Sorting & Management

The script reorganizes the file to ensure players select the correct languages automatically.

* **Language Priority:** German (1) > English (2) > Others (3).
* **Audio Sort:** Within a language, Surround tracks are placed before Stereo tracks.
* **Subtitles:** Copied via pass-through but re-sorted to match the Master Processor's logic (Forced tracks prioritized).
* **Attachments:** Explicitly checks for `mimetype` tags to prevent MKV muxer crashes when copying fonts/cover art.

---

## 🔌 Technical Implementation Notes

### The "Ghost Stream" Bypass

Both scripts utilize a specialized technique to bypass Tdarr's internal safety checks.

Tdarr normally requires plugins to map streams using specific internal objects. Because these scripts build complex, custom filter chains that Tdarr's parser cannot natively understand, we use a **Ghost Stream** approach:

```javascript
// Example from source
const ghostStreams = streams.map((s, idx) => {
    const isActive = (idx === 0);
    return {
        ...s,
        removed: !isActive, // Marks all but one stream as removed
        outputArgs: isActive ? ['-metadata', 'tdarr=true'] : [],
    };
});

```

This tricks Tdarr into believing the streams are being handled standardly, while the actual heavy lifting is done via the `overallOuputArguments` array which contains the raw FFmpeg command constructed by the script.

### Installation

1. Copy the `.js` file content into your Tdarr Local Plugins folder.
2. Scan for new plugins in Tdarr.
3. Add **Master Media Processor** to your stack first.
4. Add **Normalizer** to your stack second (it will automatically skip if no surround sound is found).
