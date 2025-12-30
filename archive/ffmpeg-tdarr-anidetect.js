module.exports = async (args) => {
  try {
    const fileObj = args.inputFileObj;
    const rawPath = fileObj._id;
    const filePath = rawPath.toLowerCase();
    // Check Path Keywords
    const animationKeywords = ['anime', 'cartoon', 'animation', 'kids'];
    let isAnimation = animationKeywords.some(keyword => filePath.includes(keyword));
    // Optional: Log to the Tdarr console so you can see what it found
    console.log(`[Detection] Path: ${filePath} | Animation: ${isAnimation}`);
    args.variables.isAnimation = isAnimation;
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: isAnimation ? 1 : 2, // Output 1 = Animation, Output 2 = Film/Grain
      variables: args.variables
    };
  } catch (err) {
    // If something goes wrong, default to Output 2 (Film/Grain) so the flow continues
    console.error("Detection Error: " + err);
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables
    };
  }
};