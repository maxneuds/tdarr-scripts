const { execSync, spawn } = require('child_process');

// --- NORMALIZATION FILTERS ---
const ACOMPRESSOR_FILTER = "acompressor=threshold=-12dB:ratio=4:attack=5:release=250:mix=0.5";
const DYNAUDNORM_FILTER = "dynaudnorm=f=125:g=13:p=0.75";
const EQUALIZER_FILTER = "equalizer=f=2000:t=q:w=1:g=2";
const HIGHPASS_FILTER = "highpass=f=20";
const ALIMITER_FILTER = "alimiter=limit=0.9";

// --- PAN FILTERS (DOWNMIX TO STEREO) ---
// Note: S(side) and B(ack) are used as safety setting for different encoders with different definitions of surround channels
const PAN_FILTER_4_0 = "pan=stereo|FL=0.9*FL+0.35*BL+0.35*SL|FR=0.9*FR+0.35*BR+0.35*SR";
const PAN_FILTER_5_1 = "pan=stereo|FL=0.9*FL+1.0*FC+0.75*LFE+0.25*BL+0.25*SL|FR=0.9*FR+1.0*FC+0.75*LFE+0.25*BR+0.25*SR";
const PAN_FILTER_7_1 = "pan=stereo|FL=0.85*FL+1.0*FC+0.75*LFE+0.35*BL+0.35*SL|FR=0.85*FR+1.0*FC+0.75*LFE+0.35*BR+0.35*SR";

// --- ARGUMENTS ---
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: node wip.js <input_file> <output_file>");
    process.exit(1);
}

// --- CONFIGURATION ---
const CONFIG = {
    inputFile: args[0],
    outputFile: args[1],
    
    // Normalization Filter Chain
    normFilter: [
        ACOMPRESSOR_FILTER,
        DYNAUDNORM_FILTER,
        EQUALIZER_FILTER,
        HIGHPASS_FILTER,
        ALIMITER_FILTER
    ].join(','),

    // Pan Filters (Downmix to Stereo)
    panFilters: {
        '4.0': PAN_FILTER_4_0,
        '5.1': PAN_FILTER_5_1,
        '7.1': PAN_FILTER_7_1
    }
};

// --- HELPERS ---
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

// --- HELPER: Get File Streams ---
function getProbeData(filePath) {
    try {
        const cmd = `ffprobe -v quiet -print_format json -show_streams "${filePath}"`;
        const result = execSync(cmd, { encoding: 'utf8' });
        return JSON.parse(result);
    } catch (err) {
        console.error("Error running ffprobe:", err.message);
        process.exit(1);
    }
}

// --- MAIN LOGIC ---
async function run() {
    console.log(`Analyzing: ${CONFIG.inputFile}`);
    const data = getProbeData(CONFIG.inputFile);
    const streams = data.streams;

    // --- 1. ANALYZE STREAMS (Logic from Master) ---
    
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

    let ffmpegArgs = ['-y', '-i', CONFIG.inputFile, '-map_metadata', '-1', '-map_chapters', '0'];
    let filterComplex = [];
    
    let videoMaps = [];
    let audioMaps = [];
    let subMaps = [];

    // --- Pre-analysis for stereo track replacement ---
    const languagesWithNewStereo = new Set();
    for (const stream of streams) {
        if (stream.codec_type === 'audio' && stream.channels >= 4) {
            // Check if we have a valid downmix profile
            let layout;
            if (stream.channels === 4) layout = '4.0';
            else if (stream.channels === 6) layout = '5.1';
            else if (stream.channels >= 8) layout = '7.1';
            
            if (layout && CONFIG.panFilters[layout]) {
                const lang = getLang(stream);
                languagesWithNewStereo.add(lang);
            }
        }
    }
    if (languagesWithNewStereo.size > 0) {
        console.log('New stereo tracks will be generated for languages:', Array.from(languagesWithNewStereo).join(', '));
    }
    
    // Process Streams
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

            // --- Replacement Logic ---
            // If we are generating a new stereo track for this language, skip any existing one.
            if (channels === 2 && title === `${lang.toUpperCase()}\u00A0Stereo` && languagesWithNewStereo.has(lang)) {
                console.log(`Replacing existing stereo track for language '${lang.toUpperCase()}'.`);
                continue; // This skips mapping the old stereo track
            }
            
            // A. If Channels >= 4, Create Normalized Stereo Version
            if (channels >= 4) {
                console.log(`Stream #${index}: Found ${channels}ch Audio. Generating Normalized Stereo...`);
                
                let layout;
                if (channels === 4) layout = '4.0';
                else if (channels === 6) layout = '5.1';
                else if (channels >= 8) layout = '7.1';

                if (layout && CONFIG.panFilters[layout]) {
                    const pan = CONFIG.panFilters[layout];
                    const filterChain = `[0:${index}]${pan},${CONFIG.normFilter}[aud_norm_${index}]`;
                    filterComplex.push(filterChain);

                    audioMaps.push({
                        sourceIndex: index,
                        isGenerated: true,
                        lang: lang,
                        channels: 2,
                        mapLabel: `[aud_norm_${index}]`,
                        title: `${lang.toUpperCase()}\u00A0Stereo`
                    });
                } else {
                    console.log(`Skipping stereo generation for stream #${index}: Unsupported channel count ${channels} or no filter.`);
                }
            }

            // B. Always keep the original stream as well
            const audioLayout = getAudioLayout(channels);
            audioMaps.push({
                sourceIndex: index,
                isGenerated: false,
                lang: lang,
                channels: channels,
                mapLabel: `0:${index}`,
                title: `${lang.toUpperCase()}\u00A0${audioLayout}`
            });

        } else if (stream.codec_type === 'subtitle') {
            if (validSubtitleIndices.includes(index)) {
                const lang = getLang(stream);
                const type = isForced(stream) ? 'Forced' : 'Full';
                subMaps.push({
                    sourceIndex: index,
                    lang: lang,
                    isForced: isForced(stream),
                    mapLabel: `0:${index}`,
                    title: `${lang.toUpperCase()}\u00A0${type}`
                });
            }
        }
    }
    
    // --- 3. SORTING ---
    const langScore = (l) => {
        if (l === 'ger' || l === 'de' || l === 'deu') return 1;
        if (l === 'eng' || l === 'en') return 2;
        return 3;
    };

    // Sort Audio: Ger < Eng < Other, then Channels Desc
    audioMaps.sort((a, b) => {
        const lsA = langScore(a.lang);
        const lsB = langScore(b.lang);
        if (lsA !== lsB) return lsA - lsB;
        return b.channels - a.channels;
    });

    // Sort Subs: Ger < Eng < Other, then Forced < Full
    subMaps.sort((a, b) => {
        const lsA = langScore(a.lang);
        const lsB = langScore(b.lang);
        if (lsA !== lsB) return lsA - lsB;
        if (a.isForced !== b.isForced) return a.isForced ? -1 : 1;
        return 0;
    });

    // --- 4. BUILD COMMAND ---
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

        // Disposition
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
        
        const isDef = (s.sourceIndex === targetDefaultSubIndex) ? 'default' : '0';
        mapArgs.push(`-disposition:s:${subOutIndex}`, isDef);

        mapArgs.push(`-metadata:s:s:${subOutIndex}`, `language=${s.lang}`);
        mapArgs.push(`-metadata:s:s:${subOutIndex}`, `title=${s.title}`);
        
        subOutIndex++;
    });

    // Map attachments
    mapArgs.push('-map', '0:t?', '-c:t', 'copy');

    // Combine Args
    let finalArgs = [...ffmpegArgs];
    if (filterComplex.length > 0) {
        finalArgs.push('-filter_complex', filterComplex.join(';'));
    }
    finalArgs.push(...mapArgs, CONFIG.outputFile);

    console.log("\nGenerated Command:");
    const commandToLog = 'ffmpeg ' + finalArgs.map(arg => arg.includes(' ') || arg.includes('\u00A0') ? `"${arg}"` : arg).join(' ');
    console.log(commandToLog);

    // --- EXECUTE ---
    console.log("\nStarting Encoding...");
    const ffmpegProcess = spawn('ffmpeg', finalArgs);

    ffmpegProcess.stdout.on('data', (data) => console.log(data.toString()));
    ffmpegProcess.stderr.on('data', (data) => console.error(data.toString())); // FFmpeg stats go to stderr

    ffmpegProcess.on('close', (code) => {
        console.log(`\nFFmpeg exited with code ${code}`);
    });
}

run();
