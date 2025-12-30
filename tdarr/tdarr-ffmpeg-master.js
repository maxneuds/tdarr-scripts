/*
 * MASTER MEDIA PROCESSOR v3.4
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
    const container = file.container || 'mkv';
    const transcodeVideo = args.variables.transcodeVideo !== "false";

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
    const videoStream = streams.find(s => s.codec_type === 'video');
    const width = videoStream ? (videoStream.width || 1920) : 1920;
    const height = videoStream ? (videoStream.height || 1080) : 1080;
    const pixel_count = width * height;
    const filePath = file._id.toLowerCase();
    const isAnimation = ['anime', 'cartoon', 'animation'].some(k => filePath.includes(k));
    
    let videoArgs = [];
    if (transcodeVideo) {
        let crf = '25'; 
        if (pixel_count >= 5000000) crf = '28'; // 4K
        else if (pixel_count >= 3000000) crf = '26'; // 2K
        else if (pixel_count >= 1000000) crf = '25'; // HD
        else crf = '32'; // SD
        // Animation: Strong Denoise, No Film Grain
        // Film: Film Grain Synth
        // Note: hqdn3d is a CPU filter, but very effective for anime
        let params = isAnimation 
            ? '-vf hqdn3d=1.5:1.5:3:3 -svtav1-params tune=0:enable-overlays=1:scd=1:enable-tf=0'
            : '-svtav1-params tune=0:enable-overlays=1:scd=1:film-grain=8';
        videoArgs.push('-c:v', 'libsvtav1', '-preset', '5', '-pix_fmt', 'yuv420p10le', '-crf', crf, params);
    } else {
        videoArgs.push('-c:v', 'copy');
    }

    // Base Command
    const fileName = file.fileNameWithoutExtension;
    const safeTitle = fileName.replace(/ /g, '\u00A0');

    let cmd = [
        '-map_metadata:g', '-1',
        '-metadata', `title=${safeTitle}`,
        '-map_chapters', '0',
        '-map', '0:v',
        ...videoArgs
    ];

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
        cmd.push(`-map 0:${s.index}`);
        
        // Codec
        const channels = s.channels || 2;
        if (s.codec_name === 'opus') {
            cmd.push(`-c:a:${audioOutIndex} copy`);
        } else {
            let bitrate = channels > 5 ? '448k' : (channels > 2 ? '320k' : '160k');
            if (channels === 1) bitrate = '96k';
            cmd.push(`-c:a:${audioOutIndex} libopus`, `-b:a:${audioOutIndex} ${bitrate}`, `-ac:a:${audioOutIndex} ${channels}`);
        }

        // Disposition (Default/0)
        const isDef = s.index === targetDefaultAudioIndex ? 'default' : '0';
        cmd.push(`-disposition:a:${audioOutIndex} ${isDef}`);

        // Metadata: Language & Title
        const langCode = getLang(s);
        const langUpper = langCode.toUpperCase();
        let layout = channels === 1 ? '1.0' : channels === 2 ? '2.0' : channels === 6 ? '5.1' : channels === 8 ? '7.1' : `${channels}ch`;
        
        // Explicitly set Language tag
        cmd.push(`-metadata:s:a:${audioOutIndex} language=${langCode}`);
        // Set friendly Title
        cmd.push(`-metadata:s:a:${audioOutIndex} title=${langUpper}\u00A0${layout}`);
        
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
        cmd.push(`-map 0:${s.index}`);
        cmd.push(`-c:s:${subOutIndex} copy`);

        // Disposition
        const isDef = s.index === targetDefaultSubIndex ? 'default' : '0';
        cmd.push(`-disposition:s:${subOutIndex} ${isDef}`);

        // Metadata: Standardized Renaming
        const langCode = getLang(s); // 'ger'
        const langUpper = langCode.toUpperCase(); // 'GER'
        
        // Logic: Forced vs Full
        const type = isForced(s) ? 'Forced' : 'Full';
        
        // Name: "GER Forced" or "ENG Full" (using non-breaking space)
        const newTitle = `${langUpper}\u00A0${type}`;

        cmd.push(`-metadata:s:s:${subOutIndex} language=${langCode}`);
        cmd.push(`-metadata:s:s:${subOutIndex} title=${newTitle}`);
        
        subOutIndex++;
    }

    // Attachments (Conditional)
    const hasAttachments = streams.some(s => s.codec_type === 'attachment' || (s.disposition && s.disposition.attached_pic === 1));
    if (hasAttachments) {
        cmd.push('-map 0:t?', '-c:t copy', '-map_metadata:s:t 0:s:t');
    }

    // Finalize
    const finalString = cmd.join(' ');
    console.log("Master Generated Command:", finalString);
    args.variables.ffmpegMasterCommand = finalString;


    // --- BYPASS OBJECT (FULL GHOST LIST) ---
    // Create ghost streams to bypass safety checks such that no unwanted video mapping occurs.
    const ghostStreams = streams.map((s, idx) => {
        const isActive = (idx === 0);
        return {
            ...s,
            removed: !isActive, 
            mapArgs: [],        
            inputArgs: [],
            outputArgs: isActive ? ['-metadata', 'tdarr_bypass=true'] : [], 
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
        overallOuputArguments: [],
    };

    args.variables.ffmpegInputArguments = "-hwaccel auto -probesize 50M -analyzeduration 100M";

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