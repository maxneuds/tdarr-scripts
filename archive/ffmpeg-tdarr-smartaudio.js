module.exports = async (args) => {
  try {
    if (!args.inputFileObj || !args.inputFileObj.ffProbeData) {
      throw new Error("File has not been scanned! ffProbeData is missing.");
    }

    args.variables.ffmpegCommand = [];

    const streams = args.inputFileObj.ffProbeData.streams;
    let commandParts = [];

    const getLangCode = (stream) => {
      if (stream.tags && stream.tags.language) {
        return stream.tags.language.toUpperCase();
      }
      return 'UND';
    };

    const getChannelLayoutName = (channels) => {
      if (channels === 1) return '1.0';
      if (channels === 2) return '2.0';
      if (channels === 3) return '2.1';
      if (channels === 6) return '5.1';
      if (channels === 8) return '7.1';
      return `${channels}ch`;
    };

    let audioIndex = 0;

    for (const stream of streams) {
      if (stream.codec_type === 'audio') {
        const channels = stream.channels || 2;
        const isOpus = stream.codec_name === 'opus';
        if (isOpus) {
          commandParts.push(`-c:a:${audioIndex} copy`);
        } else {
          let bitrate = '160k';
          if (channels === 1) bitrate = '96k';
          else if (channels <= 3) bitrate = '160k';
          else if (channels <= 5) bitrate = '280k';
          else if (channels <= 7) bitrate = '448k';
          else bitrate = '484k';
          commandParts.push(`-c:a:${audioIndex} libopus`);
          commandParts.push(`-b:a:${audioIndex} ${bitrate}`);
          commandParts.push(`-ac:a:${audioIndex} ${channels}`);
        }
        const lang = getLangCode(stream);
        const layout = getChannelLayoutName(channels);
        const title = `${lang}\u00A0${layout}`;
        commandParts.push(`-metadata:s:a:${audioIndex} title=${title}`);
        audioIndex++;
      }
    }

    const ffmpegCommand = commandParts.join(' ');
    console.log("Generated Audio Parameters:", ffmpegCommand);
    
    args.variables.ffmpegSmartAudio = ffmpegCommand;

    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 1,
      variables: args.variables,
    };

  } catch (err) {
    console.error("❌ PLUGIN CRASHED:", err.message);
    throw err;
  }
};