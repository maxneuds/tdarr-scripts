/*
 * MASTER MEDIA PROCESSOR v3.10
 * ---------------------------
 * 1. Resolution & Content Detection
 * 2. Audio Curator (Best German > Channels)
 * 3. Subtitle Deduplication (Prefer PGS over SRT)
 * 4. Subtitle Renaming (Standardized: "GER Full", "ENG Forced")
 * 5. Conditional Attachments
 * 6. Stream Sorting
 */

module.exports = async (args) => {
  try {
    // --- 1. SETUP & SAFETY ---
    if (!args.inputFileObj || !args.inputFileObj.ffProbeData) {
      throw new Error("File has not been scanned!");
    }

    const file = args.inputFileObj;
    const streams = file.ffProbeData.streams;
    const container = 'mkv';
    const transcodeVar = args.variables.user.transcodeVideo;
    const transcodeVideo = String(transcodeVar).toLowerCase() !== 'false';

    // --- 2. ANALYZE STREAMS ---
    
    // Helper: Check forced status
    const isForced = (s) => (s.disposition && s.disposition.forced === 1) || (s.tags && s.tags.title && s.tags.title.toLowerCase().includes('forced'));
    // Helper: Get lang (returns 'ger', 'eng', 'und')
    const getLang = (s) => (s.tags && s.tags.language ? s.tags.language.toLowerCase() : 'und');

    // A. Audio Curator
    let germanAudioCandidates = streams.filter(s => s.codec_type === 'audio' && getLang(s) === 'ger');
    let targetDefaultAudioIndex = -1;
    
    if (germanAudioCandidates.length > 0) {
        // Sort by Channels Descending
        germanAudioCandidates.sort((a, b) => (b.channels || 0) - (a.channels || 0));
        targetDefaultAudioIndex = germanAudioCandidates[0].index;
    } else {
        // Fallback: Keep original default or first audio
        const originalDefault = streams.find(s => s.codec_type === 'audio' && s.disposition && s.disposition.default === 1);
        targetDefaultAudioIndex = originalDefault ? originalDefault.index : (streams.find(s => s.codec_type === 'audio')?.index || -1);
    }

    const activeAudioStream = streams.find(s => s.index === targetDefaultAudioIndex);
    const activeAudioLang = activeAudioStream ? getLang(activeAudioStream) : 'und';

    // B. Subtitle Deduplication (PGS vs SRT) & Filtering
    let pgsRegistry = new Set();
    
    // Register PGS
    streams.forEach(s => {
        if (s.codec_type === 'subtitle' && s.codec_name === 'hdmv_pgs_subtitle') {
            const key = `${getLang(s)}_${isForced(s)}`;
            pgsRegistry.add(key);
        }
    });

    // Build valid subtitle list
    let validSubtitleIndices = [];
    const allowedSubLangs = ['eng', 'en', 'ger', 'de', 'deu', 'jpn', 'und'];
    
    streams.forEach(s => {
        if (s.codec_type === 'subtitle') {
            const lang = getLang(s);
            const forced = isForced(s);
            const title = (s.tags && s.tags.title || '').toLowerCase();
            
            // Filter Junk
            if (!allowedSubLangs.includes(lang) || title.includes('commentary')) return;

            // Dedupe: Skip SRT if equivalent PGS exists
            if (s.codec_name === 'subrip' && pgsRegistry.has(`${lang}_${forced}`)) {
                console.log(`[MasterNode] Removing Duplicate SRT: ${lang} (Forced: ${forced})`);
                return; 
            }
            validSubtitleIndices.push(s.index);
        }
    });

    // C. Default Subtitle Logic
    let targetDefaultSubIndex = -1;

    // 1. Ger Forced
    const gerForced = streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'ger' && isForced(s));
    
    if (gerForced) {
        targetDefaultSubIndex = gerForced.index;
    } 
    // 2. Eng Forced
    else {
        const engForced = streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'eng' && isForced(s));
        if (engForced) {
            targetDefaultSubIndex = engForced.index;
        }
        // 3. Audio Match Logic
        else {
            if (activeAudioLang === 'jpn') {
                // If Audio is Japanese, prefer English Subs
                const engFull = streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'eng' && !isForced(s));
                targetDefaultSubIndex = engFull ? engFull.index : (streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'ger' && !isForced(s))?.index || -1);
            }
        }
    }

    console.log(`[MasterNode] Audio Def: ${targetDefaultAudioIndex} | Sub Def: ${targetDefaultSubIndex}`);


    // --- 3. BUILD COMMAND ---
    
    // Video Params
    const videoStream = streams.find(s => s.codec_type === 'video' && (!s.disposition || s.disposition.attached_pic !== 1));
    const width = videoStream ? (videoStream.width || 1920) : 1920;
    const height = videoStream ? (videoStream.height || 1080) : 1080;
    const pixel_count = width * height;
    const filePath = file._id.toLowerCase();
    const isAnimation = ['anime', 'cartoon', 'animation'].some(k => filePath.includes(k));
    // HDR Detection
    // We check the transfer characteristic. 'smpte2084' = PQ (HDR10), 'arib-std-b67' = HLG.
    const srcTransfer = videoStream.color_transfer || 'unknown';
    const isHDR = (srcTransfer === 'smpte2084' || srcTransfer === 'arib-std-b67');
    
    let videoArgs = [];
    console.log(`Transcoding Video: ${transcodeVideo} | HDR Detected: ${isHDR} (${srcTransfer})`);
    if (transcodeVideo) {
        let paramsArr = [];
        let vfChain = [];

        // 1. BASE SETTINGS
        // HDR requires lower CRF (higher quality) to prevent banding in dark scenes
        let crf = isHDR ? '20' : '22';
        // Resolution-based overrides
        if (pixel_count >= 5000000) { // 4K+
            crf = isHDR ? '21' : '23';
        } else if (pixel_count >= 1000000) { // HD+
            crf = isHDR ? '20' : '22'; 
        } else { // SD
            crf = '28';
        }
        // Animation overrides (CRF bump + Denoise)
        if (isAnimation) {
            crf = String(parseInt(crf) + 2);
        }

        // 2. HDR METADATA TRANSFER
        // Film: Film Grain Synth
        if (isHDR) {
            // Extract exact source values or fallback to standard HDR10 defaults
            const prim = videoStream.color_primaries || 'bt2020';
            const trc = videoStream.color_transfer || 'smpte2084';
            const space = videoStream.color_space || 'bt2020nc';
            videoArgs.push(
                '-color_primaries', prim,
                '-color_trc', trc, 
                '-colorspace', space,
                '-chroma_sample_location', 'topleft' // Standard for 4K Blu-ray
            );
            // Lower grain for HDR (SVT-AV1 tends to over-grain HDR)
            const grain = (pixel_count >= 5000000) ? '8' : '10';
            paramsArr.push('-svtav1-params', `tune=0:enable-overlays=1:scd=1:enable-qm=1:film-grain=${grain}`);
            // Light sharpen for that "8K Detail" look on HDR
            // Only apply if not animation
            if (!isAnimation) vfChain.push('cas=0.5');
        } else {
            // --- SDR SETTINGS ---
            const grain = (pixel_count >= 5000000) ? '10' : '12';
            paramsArr.push('-svtav1-params', `tune=0:enable-overlays=1:scd=1:film-grain=${grain}`);
        }

        // 3. ANIMATION FILTERS
        // Animation: Strong Denoise, No Film Grain
        if (isAnimation) {
            // Override previous filters: Denoise is king for animation
            vfChain = ['hqdn3d=1.5:1.5:3:3']; 
            // Disable film grain synth for animation
            paramsArr = ['-svtav1-params', 'tune=0:enable-overlays=1:scd=1:enable-tf=0']; 
        }

        // 4. COMPILE COMMAND
        if (vfChain.length > 0) {
            videoArgs.push('-vf', vfChain.join(','));
        }
        videoArgs.push('-c:v', 'libsvtav1', '-preset', '5', '-pix_fmt', 'yuv420p10le', '-crf', crf, ...paramsArr);
    } else {
        videoArgs.push('-c:v', 'copy');
    }
    // Force mkv
    videoArgs.push('-f', 'matroska')

    // Base Command
    const fileName = file.fileNameWithoutExtension;
    const safeTitle = fileName;

    let cmd = [
        '-map_metadata:g', '-1',
        '-metadata', `title=${safeTitle}`,
        '-map_chapters', '0',
    ];
    // Map explicit video index to exclude Cover Art (which would be included by 0:v)
    if (videoStream) {
        cmd.push('-map', `0:${videoStream.index}`);
    } else {
        cmd.push('-map', '0:v');
    }
    cmd.push(...videoArgs);

    // --- SORTING HELPERS ---
    const langScore = (l) => {
        if (['ger', 'de', 'deu'].includes(l)) return 1;
        if (['eng', 'en'].includes(l)) return 2;
        return 3;
    };

    // Audio Loop
    let audioOutIndex = 0;
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    
    audioStreams.sort((a, b) => {
        const lsA = langScore(getLang(a));
        const lsB = langScore(getLang(b));
        if (lsA !== lsB) return lsA - lsB;
        return (b.channels || 0) - (a.channels || 0);
    });

    for (const s of audioStreams) {
        cmd.push(`-map`, `0:${s.index}`); // Split map and index for arg array
        
        // Codec
        const channels = s.channels || 2;
        if (s.codec_name === 'opus') {
            cmd.push(`-c:a:${audioOutIndex}`, 'copy');
        } else {
            let bitrate = channels > 5 ? '448k' : (channels > 2 ? '320k' : '160k');
            if (channels === 1) bitrate = '96k';
            cmd.push(`-c:a:${audioOutIndex}`, 'libopus', `-b:a:${audioOutIndex}`, bitrate, `-ac:a:${audioOutIndex}`, `${channels}`);
        }

        // Disposition (Default/0)
        const isDef = s.index === targetDefaultAudioIndex ? 'default' : '0';
        cmd.push(`-disposition:a:${audioOutIndex}`, isDef);

        // Metadata: Language & Title
        const langCode = getLang(s);
        const langUpper = langCode.toUpperCase();
        let layout = channels === 1 ? '1.0' : channels === 2 ? '2.0' : channels === 6 ? '5.1' : channels === 8 ? '7.1' : `${channels}ch`;
        const audioTitle = `${langUpper} ${layout}`;
        // Explicitly set Language tag
        cmd.push(`-metadata:s:a:${audioOutIndex}`, `language=${langCode}`);
        cmd.push(`-metadata:s:a:${audioOutIndex}`, `title=${audioTitle}`);
        
        audioOutIndex++;
    }

    // Subtitle Loop
    let subOutIndex = 0;
    const subStreams = streams.filter(s => s.codec_type === 'subtitle' && validSubtitleIndices.includes(s.index));
    subStreams.sort((a, b) => {
        const lsA = langScore(getLang(a));
        const lsB = langScore(getLang(b));
        if (lsA !== lsB) return lsA - lsB;
        const forcedA = isForced(a);
        const forcedB = isForced(b);
        if (forcedA !== forcedB) return forcedA ? -1 : 1;
        return 0;
    });

    for (const s of subStreams) {
        cmd.push(`-map`, `0:${s.index}`);
        cmd.push(`-c:s:${subOutIndex}`, 'copy');

        // Disposition Logic (Preserve Forced)
        let dispFlags = [];
        // 1. Is Default?
        if (s.index === targetDefaultSubIndex) {
            dispFlags.push('default');
        }
        // 2. Is Forced? (Check original stream)
        if (isForced(s)) {
            dispFlags.push('forced');
        }
        // 3. Combine
        const dispositionStr = dispFlags.length > 0 ? dispFlags.join('+') : '0';
        cmd.push(`-disposition:s:${subOutIndex}`, dispositionStr);

        // Metadata: Standardized Renaming
        const langCode = getLang(s); // 'ger'
        const langUpper = langCode.toUpperCase(); // 'GER'
        
        // Logic: Forced vs Full vs SDH
        let type = isForced(s) ? 'Forced' : 'Full';
        if ((s.tags && s.tags.title || '').toLowerCase().includes('sdh')) {
            type = 'SDH';
        }
        
        // Rename subtitle streams to standardized names
        // Name: "GER Forced" or "ENG Full"
        const newTitle = `${langUpper} ${type}`;
        cmd.push(`-metadata:s:s:${subOutIndex}`, `language=${langCode}`);
        cmd.push(`-metadata:s:s:${subOutIndex}`, `title=${newTitle}`);
        
        subOutIndex++;
    }

    // Attachments (Conditional)
    // Strictly check for 'attachment' type to exclude cover art videos
    // Check for missing mimetypes to prevent MKV muxer crash
    const attachmentStreams = streams.filter(s => s.codec_type === 'attachment');
    let hasMappedAttachment = false;

    attachmentStreams.forEach(s => {
        const hasMimetype = s.tags && (s.tags.mimetype || s.tags.MIMETYPE || s.tags['Content-Type']);
        if (hasMimetype) {
            cmd.push('-map', `0:${s.index}`);
            hasMappedAttachment = true;
        } else {
            console.log(`[MasterNode] Skipping Attachment Stream ${s.index}: No Mimetype Tag.`);
        }
    });

    if (hasMappedAttachment) {
        cmd.push('-c:t', 'copy', '-map_metadata:s:t', '0:s:t');
    }

    // --- BYPASS OBJECT (FULL GHOST LIST) ---
    // Create ghost streams to bypass safety checks such that no unwanted video mapping occurs.
    const ghostStreams = streams.map((s, idx) => {
        const isActive = (idx === 0);
        return {
            ...s,
            removed: !isActive, 
            mapArgs: [],        
            inputArgs: [],
            outputArgs: isActive ? ['-metadata', 'tdarr=true'] : [], 
        };
    });

    args.variables.ffmpegCommand = {
        init: true,
        inputFiles: [],
        streams: ghostStreams,
        container: container,
        hardwareDecoding: false,
        shouldProcess: false,
        overallInputArguments: [],
        overallOuputArguments: cmd,
    };

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };

  } catch (err) {
    console.error("Master Node Error:", err);
    throw err;
  }
};