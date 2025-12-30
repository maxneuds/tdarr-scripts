module.exports = async (args) => {
  try {
    const streams = args.inputFileObj.ffProbeData.streams;
    const fileName = args.inputFileObj.fileNameWithoutExtension;
    
    // --- METADATA CLEANING ---
    const safeTitle = fileName.replace(/ /g, '\u00A0');
    let cleanParts = [
        // 1. Wipe global metadata (Commentary, encoded_by, etc.)
      '-map_metadata:g', '-1', 
      // 2. Set the clean Title
      '-metadata', `title=${safeTitle}`,
      // 3. CRITICAL: Explicitly copy stream metadata for Attachments (Fonts)
      '-map_metadata:s:t', '0:s:t',
      // 4. Map Chapters
      '-map_chapters', '0'
    ];

    // --- SUBTITLE FILTERING ---
    const allowedLangs = ['eng', 'en', 'ger', 'de', 'deu', 'und'];
    let subIdx = 0;
    for (const stream of streams) {
      if (stream.codec_type === 'subtitle') {
        const lang = (stream.tags && stream.tags.language || 'und').toLowerCase();
        const title = (stream.tags && stream.tags.title || '').toLowerCase();
        
        if (allowedLangs.includes(lang) && !title.includes('commentary')) {
          cleanParts.push(`-map`, `0:s:${subIdx}`, `-c:s`, `copy`);
        }
        subIdx++;
      }
    }

    args.variables.ffmpegCleanRemux = cleanParts.join(' ');

    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 1,
      variables: args.variables,
    };
  } catch (err) {
    console.error("Clean Node Error:", err);
    throw err;
  }
};