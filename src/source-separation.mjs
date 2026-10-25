const safeExtension = (name) => name.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0].toLowerCase() ?? ".mp4";

const safeStem = (name) => {
  const stem = name.split(/[\\/]/).pop().replace(/\.[^.]*$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  return stem || "video";
};

export const buildSourceSeparationPlan = (media) => {
  if (!media || media.kind !== "video" || !media.file) {
    throw new Error("Select an available video source before separating its audio.");
  }

  const baseName = safeStem(media.name);
  const inputPath = `separation-source${safeExtension(media.name)}`;
  const videoPath = "separated-video.mp4";
  const audioPath = "separated-audio.m4a";

  return {
    inputPath,
    videoPath,
    audioPath,
    videoName: `${baseName}-video-only.mp4`,
    audioName: `${baseName}-audio.m4a`,
    videoArgs: [
      "-i", inputPath,
      "-map", "0:v:0",
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      videoPath,
    ],
    audioArgs: [
      "-i", inputPath,
      "-map", "0:a:0",
      "-vn",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-movflags", "+faststart",
      audioPath,
    ],
  };
};
