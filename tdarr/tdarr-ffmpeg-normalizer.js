/*
 * NORMALIZER v1.6
 * ---------------------------------
 * 1. Analyzes audio streams.
 * 2. Downmixes Surround (4.0/5.1/7.1) to Stereo with normalization.
 * 3. Sorts streams (Ger > Eng > Other).
 * 4. Disables Live Size Check for this run.
 * 5. Safe Attachment Mapping (Preserves Mimetype).
 * 6. Includes "Ghost Stream" logic to prevent Tdarr "No streams mapped" error.
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

    // Check for surround sound (channels >= 4)
    const hasSurround = streams.some(s => s.codec_type === 'audio' && (s.channels || 2) >= 4);
    if (!hasSurround) {
        console.log("No surround sound detected. Skipping normalizer.");
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }

    // --- 2. CONSTANTS & FILTERS ---
    const DYNAUDNORM_FILTER = "dynaudnorm=f=250:g=31:p=0.95:m=10";
    const EQUALIZER_FILTER = "equalizer=f=2000:t=q:w=1:g=2";
    const HIGHPASS_FILTER = "highpass=f=20";
    const ALIMITER_FILTER = "alimiter=limit=0.9";

    const NORM_FILTER = [
        DYNAUDNORM_FILTER,
        EQUALIZER_FILTER,
        HIGHPASS_FILTER,
        ALIMITER_FILTER
    ].join(',');

    const PAN_FILTERS = {
        '4.0': "pan=stereo|FL<FL+0.7*BL+0.7*SL|FR<FR+0.7*BR+0.7*SR",
        '5.1': "pan=stereo|FL<FL+1.0*FC+0.6*SL+1.0*LFE|FR<FR+1.0*FC+0.6*SR+1.0*LFE",
        '7.1': "pan=stereo|FL<FL+1.0*FC+0.6*BL+0.6*SL+1.0*LFE|FR<FR+1.0*FC+0.6*BR+0.6*SR+1.0*LFE",
    };

    // --- 3. HELPERS ---
    const isForced = (s) => (s.disposition && s.disposition.forced === 1) || (s.tags && s.tags.title && s.tags.title.toLowerCase().includes('forced'));
    const getLang = (s) => (s.tags && s.tags.language ? s.tags.language.toLowerCase() : 'und');
    const getAudioLayout = (channels) => {
        switch (channels) {
            case 1: return '1.0';
            case 2: return '2.0';
            case 6: return '5.1';
            case 8: return '7.1';
            default: return `${channels}ch`;
        }
    };

    // --- 4. ANALYZE STREAMS ---
    
    // A. Audio Curator (Find Default)
    let germanAudioCandidates = streams.filter(s => s.codec_type === 'audio' && getLang(s) === 'ger');
    let targetDefaultAudioIndex = -1;
    
    if (germanAudioCandidates.length > 0) {
        germanAudioCandidates.sort((a, b) => (b.channels || 0) - (a.channels || 0));
        targetDefaultAudioIndex = germanAudioCandidates[0].index;
    } else {
        const originalDefault = streams.find(s => s.codec_type === 'audio' && s.disposition && s.disposition.default === 1);
        targetDefaultAudioIndex = originalDefault ? originalDefault.index : (streams.find(s => s.codec_type === 'audio')?.index || -1);
    }

    const activeAudioStream = streams.find(s => s.index === targetDefaultAudioIndex);
    const activeAudioLang = activeAudioStream ? getLang(activeAudioStream) : 'und';

    // B. Subtitle Deduplication
    let pgsRegistry = new Set();
    streams.forEach(s => {
        if (s.codec_type === 'subtitle' && s.codec_name === 'hdmv_pgs_subtitle') {
            const key = `${getLang(s)}_${isForced(s)}`;
            pgsRegistry.add(key);
        }
    });

    let validSubtitleIndices = [];
    const allowedSubLangs = ['eng', 'en', 'ger', 'de', 'deu', 'jpn', 'und'];
    
    streams.forEach(s => {
        if (s.codec_type === 'subtitle') {
            const lang = getLang(s);
            const forced = isForced(s);
            const title = (s.tags && s.tags.title || '').toLowerCase();
            
            if (!allowedSubLangs.includes(lang) || title.includes('commentary')) return;

            if (s.codec_name === 'subrip' && pgsRegistry.has(`${lang}_${forced}`)) {
                return; 
            }
            validSubtitleIndices.push(s.index);
        }
    });

    // C. Default Subtitle Logic
    let targetDefaultSubIndex = -1;
    const gerForced = streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'ger' && isForced(s));
    
    if (gerForced) {
        targetDefaultSubIndex = gerForced.index;
    } else {
        const engForced = streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'eng' && isForced(s));
        if (engForced) {
            targetDefaultSubIndex = engForced.index;
        } else {
            if (activeAudioLang === 'jpn') {
                const engFull = streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'eng' && !isForced(s));
                targetDefaultSubIndex = engFull ? engFull.index : (streams.find(s => validSubtitleIndices.includes(s.index) && getLang(s) === 'ger' && !isForced(s))?.index || -1);
            }
        }
    }

    // --- 5. BUILD MAPS ---
    let filterComplex = [];
    let videoMaps = [];
    let audioMaps = [];
    let subMaps = [];

    // Pre-analysis for stereo track replacement
    const languagesWithNewStereo = new Set();
    for (const stream of streams) {
        if (stream.codec_type === 'audio' && stream.channels >= 4) {
            let layout;
            if (stream.channels === 4) layout = '4.0';
            else if (stream.channels === 6) layout = '5.1';
            else if (stream.channels >= 8) layout = '7.1';
            
            if (layout && PAN_FILTERS[layout]) {
                languagesWithNewStereo.add(getLang(stream));
            }
        }
    }

    for (const stream of streams) {
        const index = stream.index;
        
        if (stream.codec_type === 'video') {
            videoMaps.push({
                index: index,
                args: ['-map', `0:${index}`, '-c:v', 'copy']
            });
        }
        else if (stream.codec_type === 'audio') {
            const channels = stream.channels || 2;
            const lang = getLang(stream);
            const title = stream.tags ? stream.tags.title : '';

            // Skip existing stereo if we are generating a new one
            if (channels === 2 && title === `${lang.toUpperCase()} 2.0` && languagesWithNewStereo.has(lang)) {
                continue; 
            }
            
            // Generate Stereo
            if (channels >= 4) {
                let layout;
                if (channels === 4) layout = '4.0';
                else if (channels === 6) layout = '5.1';
                else if (channels >= 8) layout = '7.1';

                if (layout && PAN_FILTERS[layout]) {
                    const pan = PAN_FILTERS[layout];
                    const filterChain = `[0:${index}]${pan},${NORM_FILTER}[aud_norm_${index}]`;
                    filterComplex.push(filterChain);

                    audioMaps.push({
                        sourceIndex: index,
                        isGenerated: true,
                        lang: lang,
                        channels: 2,
                        mapLabel: `[aud_norm_${index}]`,
                        title: `${lang.toUpperCase()} 2.0`
                    });
                }
            }

            // Keep Original
            const audioLayout = getAudioLayout(channels);
            audioMaps.push({
                sourceIndex: index,
                isGenerated: false,
                lang: lang,
                channels: channels,
                mapLabel: `0:${index}`,
                title: `${lang.toUpperCase()} ${audioLayout}`
            });

        } else if (stream.codec_type === 'subtitle') {
            if (validSubtitleIndices.includes(index)) {
                const lang = getLang(stream);
                let type = isForced(stream) ? 'Forced' : 'Full';
                if ((stream.tags && stream.tags.title || '').toLowerCase().includes('sdh')) {
                    type = 'SDH';
                }

                subMaps.push({
                    sourceIndex: index,
                    lang: lang,
                    isForced: isForced(stream),
                    mapLabel: `0:${index}`,
                    title: `${lang.toUpperCase()} ${type}`
                });
            }
        }
    }

    // --- 6. SORTING ---
    const langScore = (l) => {
        if (['ger', 'de', 'deu'].includes(l)) return 1;
        if (['eng', 'en'].includes(l)) return 2;
        return 3;
    };

    audioMaps.sort((a, b) => {
        const lsA = langScore(a.lang);
        const lsB = langScore(b.lang);
        if (lsA !== lsB) return lsA - lsB;
        return b.channels - a.channels;
    });

    subMaps.sort((a, b) => {
        const lsA = langScore(a.lang);
        const lsB = langScore(b.lang);
        if (lsA !== lsB) return lsA - lsB;
        if (a.isForced !== b.isForced) return a.isForced ? -1 : 1;
        return 0;
    });

    // --- 7. BUILD COMMAND ARRAY ---
    let mapArgs = [];
    
    // Video
    videoMaps.forEach(v => mapArgs.push(...v.args));

    // Audio
    let audioOutIndex = 0;
    audioMaps.forEach(a => {
        mapArgs.push('-map', a.mapLabel);
        
        if (a.isGenerated) {
            mapArgs.push(`-c:a:${audioOutIndex}`, 'libopus', `-b:a:${audioOutIndex}`, '192k');
        } else {
            mapArgs.push(`-c:a:${audioOutIndex}`, 'copy');
        }

        const isDef = (!a.isGenerated && a.sourceIndex === targetDefaultAudioIndex) ? 'default' : '0';
        mapArgs.push(`-disposition:a:${audioOutIndex}`, isDef);
        mapArgs.push(`-metadata:s:a:${audioOutIndex}`, `language=${a.lang}`);
        mapArgs.push(`-metadata:s:a:${audioOutIndex}`, `title=${a.title}`);
        
        audioOutIndex++;
    });

    // Subtitles
    let subOutIndex = 0;
    subMaps.forEach(s => {
        mapArgs.push('-map', s.mapLabel);
        mapArgs.push(`-c:s:${subOutIndex}`, 'copy');
        
        // Disposition Logic (Default + Forced)
        let dispFlags = [];
        // 1. Check Default preference
        if (s.sourceIndex === targetDefaultSubIndex) {
            dispFlags.push('default');
        }
        // 2. Check Forced (Preserve existing flag)
        if (s.isForced) {
            dispFlags.push('forced');
        }
        // 3. Combine or set 0
        const dispositionStr = dispFlags.length > 0 ? dispFlags.join('+') : '0';
        mapArgs.push(`-disposition:s:${subOutIndex}`, dispositionStr);
        mapArgs.push(`-metadata:s:s:${subOutIndex}`, `language=${s.lang}`);
        mapArgs.push(`-metadata:s:s:${subOutIndex}`, `title=${s.title}`);
        
        subOutIndex++;
    });

    // 1. Checks if attachment has mimetype to prevent FFmpeg crash.
    // 2. Explicitly maps metadata for attachments (overriding global strip).
    const attachmentStreams = streams.filter(s => s.codec_type === 'attachment');
    let hasMappedAttachment = false;

    attachmentStreams.forEach(s => {
        // Check if mimetype tag exists
        const hasMimetype = s.tags && (s.tags.mimetype || s.tags.MIMETYPE || s.tags['Content-Type']);
        
        if (hasMimetype) {
            mapArgs.push('-map', `0:${s.index}`);
            hasMappedAttachment = true;
        } else {
            console.log(`[Normalizer] Skipping Attachment Stream ${s.index}: No Mimetype Tag.`);
        }
    });

    if (hasMappedAttachment) {
        mapArgs.push('-c:t', 'copy');
        // CRITICAL: Explicitly copy attachment metadata, otherwise -map_metadata -1 wipes the mimetype!
        mapArgs.push('-map_metadata:s:t', '0:s:t');
    }

    // Combine
    let finalArgs = ['-map_metadata', '-1', '-map_chapters', '0'];
    if (filterComplex.length > 0) {
        finalArgs.push('-filter_complex', filterComplex.join(';'));
    }
    finalArgs.push(...mapArgs);

    // Log the joined array for debug
    console.log("Normalizer Generated Command:", finalArgs.join(' '));

    // --- 8. BYPASS OBJECT (FULL GHOST LIST) ---
    // We map ALL streams but mark them "removed: true".
    // This ensures Tdarr's index matches the file, but it adds NO maps.
    // We strictly enable Stream 0 (with dummy args) to satisfy the "No Streams Mapped" safety check.
    
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
        shouldProcess: true,
        overallInputArguments: [],
        overallOuputArguments: finalArgs,
    };

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };

  } catch (err) {
    console.error("Normalizer Node Error:", err);
    throw err;
  }
};