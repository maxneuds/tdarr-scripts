module.exports = async (args) => {
  try {
    // --- 1. SAFETY CHECKS ---
    if (!args.inputFileObj || !args.inputFileObj.ffProbeData) {
      throw new Error("File has not been scanned! ffProbeData is missing.");
    }

    const file = args.inputFileObj;
    const streams = file.ffProbeData.streams;
    const container = file.container || 'mkv';
    const transcodeVideo = args.variables.transcodeVideo !== "false"; // Default to true
    
    // --- 2. DETECTION LOGIC ---
    
    // A. Detect Resolution (Width)
    // Find video stream
    const videoStream = streams.find(s => s.codec_type === 'video');
    if (!videoStream) throw new Error("No video stream found!");
    const width = videoStream.width || 1920; // Default to HD if missing

    // B. Detect Animation (Path Keywords)
    const filePath = file._id.toLowerCase();
    const animKeywords = ['anime', 'cartoon', 'animation'];
    const isAnimation = animKeywords.some(k => filePath.includes(k));
    
    console.log(`[MasterNode] Width: ${width} | Animation: ${isAnimation}`);

    // --- 3. PARAMETER SELECTION ---
    
    // Quality Tier Logic
    let crf = '25'; // Default HD
    if (width >= 3000) {
      // UHD / 4K
      crf = '28'; 
    } else if (width >= 2000) {
      // HD / 2k
      crf = '26';
    } else if (width >= 1500) {
      // HD / 1080p
      crf = '25';
    } else {
      // SD / 480p / 576p
      crf = '32';
    }

    // Content Type Logic
    let params = '';
    if (isAnimation) {
      // Animation: Strong Denoise, No Film Grain
      // Note: hqdn3d is a CPU filter, but very effective for anime
      params = '-vf hqdn3d=1.5:1.5:3:3 -svtav1-params tune=0:enable-overlays=1:scd=1:enable-tf=0';
    } else {
      // Film: Film Grain Synth
      params = '-svtav1-params tune=0:enable-overlays=1:scd=1:film-grain=8';
    }

    // --- 4. BUILD COMMAND STRING ---
    const fileName = file.fileNameWithoutExtension;
    const safeTitle = fileName.replace(/ /g, '\u00A0'); // Non-breaking space for metadata

    let cmd = [];

    // Global Metadata
    cmd.push('-map_metadata:g', '-1');
    cmd.push('-metadata', `title=${safeTitle}`);
    cmd.push('-map_chapters', '0');

    // VIDEO MAPPING & ENCODING
    // We map 0:v explicitly so we control the order
    cmd.push('-map', '0:v');
    cmd.push('-c:v', 'libsvtav1');
    cmd.push('-preset', '5');
    cmd.push('-pix_fmt', 'yuv420p10le');
    cmd.push('-crf', crf);
    
    // Inject the content-specific params (Filters + SVT Args)
    // We split by space to ensure proper array formatting for Tdarr if strictly needed,
    // but building a raw string is safer for "Custom Arguments" node injection.
    cmd.push(params);

    // AUDIO LOGIC
    let audioOutIndex = 0;
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      if (s.codec_type === 'audio') {
        cmd.push(`-map 0:${i}`);
        
        const channels = s.channels || 2;
        const isOpus = s.codec_name === 'opus';
        const lang = (s.tags && s.tags.language || 'UND').toUpperCase();
        
        let layout = `${channels}ch`;
        if (channels === 1) layout = '1.0';
        if (channels === 2) layout = '2.0';
        if (channels === 6) layout = '5.1';
        if (channels === 8) layout = '7.1';
        
        const title = `${lang}\u00A0${layout}`;

        if (isOpus) {
          cmd.push(`-c:a:${audioOutIndex} copy`);
        } else {
          let bitrate = '160k';
          if (channels === 1) bitrate = '96k';
          else if (channels <= 2) bitrate = '160k';
          else if (channels <= 5) bitrate = '320k';
          else bitrate = '484k';

          cmd.push(`-c:a:${audioOutIndex} libopus`);
          cmd.push(`-b:a:${audioOutIndex} ${bitrate}`);
          cmd.push(`-ac:a:${audioOutIndex} ${channels}`);
        }
        cmd.push(`-metadata:s:a:${audioOutIndex} title=${title}`);
        audioOutIndex++;
      }
    }

    // SUBTITLE LOGIC
    let subOutIndex = 0;
    const allowedLangs = ['eng', 'en', 'ger', 'de', 'deu', 'und', 'jpn'];
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      if (s.codec_type === 'subtitle') {
        const lang = (s.tags && s.tags.language || 'und').toLowerCase();
        const title = (s.tags && s.tags.title || '').toLowerCase();
        
        if (allowedLangs.includes(lang) && !title.includes('commentary')) {
          cmd.push(`-map 0:${i}`);
          cmd.push(`-c:s:${subOutIndex} copy`);
          subOutIndex++;
        }
      }
    }

    // ATTACHMENT LOGIC (Fonts)
    // Critical: Map fonts and copy metadata to avoid MKV crash
    cmd.push('-map 0:t?');
    cmd.push('-c:t copy');
    cmd.push('-map_metadata:s:t 0:s:t');

    // Final Join
    const finalCommandString = cmd.join(' ');
    console.log("Master Generated Command:", finalCommandString);
    
    // Save to Variable
    args.variables.ffmpegMasterCommand = finalCommandString;

    // --- 5. THE "DUMMY OBJECT" TRICK ---
    // We must pass a dummy stream object to Tdarr to prevent "No Streams Mapped" error.
    // We explicitly mark outputArgs so Tdarr doesn't auto-add "-c copy".
    
    const dummyStream = {
      ...videoStream,
      removed: false,
      mapArgs: [], // No map flags
      inputArgs: [],
      outputArgs: ['-metadata', 'tdarr_bypass=true'] // Dummy arg prevents auto-copy
    };

    args.variables.ffmpegCommand = {
      init: true,
      inputFiles: [],
      streams: [dummyStream], // Only seeing 1 stream keeps Tdarr simple
      container: container,
      hardwareDecoding: false,
      shouldProcess: false,
      overallInputArguments: [],
      overallOuputArguments: [],
    };

    // Hardware Decode Flag
    args.variables.ffmpegInputArguments = "-hwaccel auto";

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