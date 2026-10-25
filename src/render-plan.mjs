const seconds = (value) => Number(value.toFixed(6)).toString();
const safeExtension = (name, fallback) => name.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0].toLowerCase() ?? fallback;

const buildTuningSegments = (clip, events) => {
  if (!Array.isArray(events)) throw new Error("Auto-Tune export analysis is missing for an enabled audio clip.");
  const segments = [];
  let start = clip.sourceStart;
  let semitones = 0;
  for (const event of events) {
    if (
      !Number.isFinite(event.time) || event.time < start || event.time < clip.sourceStart || event.time > clip.sourceEnd ||
      !Number.isFinite(event.semitones) || event.semitones < -6 || event.semitones > 6
    ) throw new Error("Auto-Tune export analysis returned invalid pitch events.");
    if (event.time > start) segments.push({ start, end: event.time, semitones });
    start = event.time;
    semitones = event.semitones;
  }
  if (clip.sourceEnd > start) segments.push({ start, end: clip.sourceEnd, semitones });
  return segments;
};

export const buildRenderPlan = ({
  duration,
  sequence,
  videoClips,
  audioClips,
  videoTracks,
  audioTracks,
  media,
  preset = "sequence",
  autoTuneEvents = new Map(),
}) => {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Add clips to the timeline before exporting.");
  if (!Number.isInteger(sequence.width) || !Number.isInteger(sequence.height) || !sequence.frameRate) {
    throw new Error("Sequence settings are incomplete.");
  }

  const mediaById = new Map(media.map((item) => [item.id, item]));
  const hasSolo = audioTracks.some((track) => track.solo);
  const audibleAudio = audioClips.filter((clip) => {
    const track = audioTracks.find((entry) => entry.id === clip.trackId);
    return track && !track.muted && (!hasSolo || track.solo) && !clip.muted && clip.volume > 0 && track.volume > 0;
  });
  const sourceEntries = new Map();
  for (const clip of [...videoClips, ...audibleAudio]) {
    const item = mediaById.get(clip.mediaId);
    if (!item?.file) throw new Error(`Relink “${item?.name ?? "missing media"}” before exporting.`);
    if (!sourceEntries.has(item.id)) {
      sourceEntries.set(item.id, {
        path: `source-${sourceEntries.size}${safeExtension(item.name, item.kind === "video" ? ".mp4" : ".wav")}`,
        file: item.file,
        kind: item.kind,
      });
    }
  }

  const titleEntries = [];
  for (const clip of videoClips) {
    if (clip.title) {
      titleEntries.push({
        clipId: clip.id,
        path: `title-${titleEntries.length}.png`,
        file: clip.titleImage,
      });
    }
  }
  if (titleEntries.some((entry) => !entry.file)) throw new Error("Could not create a title overlay for export.");

  const inputs = [...sourceEntries.values(), ...titleEntries.map(({ path, file }) => ({ path, file, title: true }))];
  const inputIndexByPath = new Map(inputs.map((entry, index) => [entry.path, index]));
  const videoTrackOrder = new Map(videoTracks.map((track, index) => [track.id, index]));
  const frameSize = `${sequence.width}x${sequence.height}`;
  const frameRate = seconds(sequence.frameRate);
  const filters = [
    `color=c=black:s=${frameSize}:r=${frameRate}:d=${seconds(duration)},format=rgba[base0]`,
  ];
  let base = "base0";
  let compositeCount = 0;
  const orderedVideo = [...videoClips].sort((left, right) =>
    (videoTrackOrder.get(left.trackId) ?? 0) - (videoTrackOrder.get(right.trackId) ?? 0) ||
    left.start - right.start,
  );
  for (const clip of orderedVideo) {
    const item = mediaById.get(clip.mediaId);
    const input = sourceEntries.get(item.id);
    const inputIndex = inputIndexByPath.get(input.path);
    const length = clip.sourceEnd - clip.sourceStart;
    const start = seconds(clip.start);
    const end = seconds(clip.start + length);
    const transitionIn = clip.transitionIn ?? ((clip.fadeIn ?? 0) > 0 ? "fade" : "cut");
    const transitionOut = clip.transitionOut ?? ((clip.fadeOut ?? 0) > 0 ? "fade" : "cut");
    const color = clip.color ?? { brightness: 0, contrast: 1, saturation: 1, hue: 0 };
    const videoLabel = `video${compositeCount}`;
    const chain = `[${inputIndex}:v]trim=start=${seconds(clip.sourceStart)}:duration=${seconds(length)},setpts=PTS-STARTPTS+${start}/TB,scale=${frameSize}:force_original_aspect_ratio=decrease,pad=${sequence.width}:${sequence.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=${seconds(sequence.pixelAspect)},fps=${frameRate},format=rgba,eq=brightness=${seconds(color.brightness)}:contrast=${seconds(color.contrast)}:saturation=${seconds(color.saturation)},hue=h=${seconds(color.hue)}[${videoLabel}]`;
    filters.push(chain);
    let activeVideoLabel = videoLabel;
    const title = titleEntries.find((entry) => entry.clipId === clip.id);
    if (title) {
      const titleIndex = inputIndexByPath.get(title.path);
      const titleLabel = `title${compositeCount}`;
      const titledVideoLabel = `titled${compositeCount}`;
      filters.push(`[${titleIndex}:v]format=rgba[${titleLabel}]`);
      filters.push(`[${activeVideoLabel}][${titleLabel}]overlay=x=0:y=0:eof_action=pass:shortest=0[${titledVideoLabel}]`);
      activeVideoLabel = titledVideoLabel;
    }
    const fades = [];
    if (clip.fadeIn > 0 && transitionIn === "fade") {
      fades.push(`fade=t=in:st=${start}:d=${seconds(clip.fadeIn)}:alpha=1`);
    }
    if (clip.fadeOut > 0 && transitionOut === "fade") {
      fades.push(`fade=t=out:st=${seconds(clip.start + length - clip.fadeOut)}:d=${seconds(clip.fadeOut)}:alpha=1`);
    }
    if (fades.length > 0) {
      const fadedVideoLabel = `${videoLabel}f`;
      filters.push(`[${activeVideoLabel}]${fades.join(",")}[${fadedVideoLabel}]`);
      activeVideoLabel = fadedVideoLabel;
    }
    const nextBase = `base${++compositeCount}`;
    filters.push(`[${base}][${activeVideoLabel}]overlay=eof_action=pass:shortest=0:enable='between(t,${start},${end})'[${nextBase}]`);
    base = nextBase;
  }
  filters.push(`[${base}]fps=${frameRate},format=yuv420p[vout]`);

  if (audibleAudio.length > 0) {
    audibleAudio.forEach((clip, index) => {
      const item = mediaById.get(clip.mediaId);
      const input = sourceEntries.get(item.id);
      const track = audioTracks.find((entry) => entry.id === clip.trackId);
      const length = clip.sourceEnd - clip.sourceStart;
      let sourceLabel = `${inputIndexByPath.get(input.path)}:a`;
      if (clip.autoTune?.enabled) {
        if (!autoTuneEvents.has(clip.id)) {
          throw new Error(`Auto-Tune analysis is missing for ${item.name}. Analyze the clip and retry the export.`);
        }
        const segments = buildTuningSegments(clip, autoTuneEvents.get(clip.id));
        const segmentLabels = segments.map((segment, segmentIndex) => {
          const label = `tune${index}_${segmentIndex}`;
          const segmentLength = segment.end - segment.start;
          const chain = [
            "aresample=48000",
            `atrim=start=${seconds(segment.start)}:duration=${seconds(segmentLength)}`,
            "asetpts=PTS-STARTPTS",
          ];
          if (Math.abs(segment.semitones) >= 0.01) {
            const rate = Math.round(48000 * 2 ** (segment.semitones / 12));
            chain.push(`asetrate=${rate}`, "aresample=48000", `atempo=${seconds(48000 / rate)}`);
          }
          filters.push(`[${sourceLabel}]${chain.join(",")}[${label}]`);
          return label;
        });
        if (segmentLabels.length === 0) throw new Error(`Auto-Tune analysis did not cover ${item.name}.`);
        sourceLabel = segmentLabels[0];
        if (segmentLabels.length > 1) {
          sourceLabel = `tuned${index}`;
          filters.push(`${segmentLabels.map((label) => `[${label}]`).join("")}concat=n=${segmentLabels.length}:v=0:a=1[${sourceLabel}]`);
        }
      }
      const chain = [
        ...(clip.autoTune?.enabled ? [] : [
          `atrim=start=${seconds(clip.sourceStart)}:duration=${seconds(length)}`,
          "asetpts=PTS-STARTPTS",
        ]),
        ...(clip.noiseReduction > 0 ? [`afftdn=nr=${seconds(clip.noiseReduction)}:nf=-25`] : []),
        `volume=${seconds(clip.volume * track.volume)}`,
      ];
      if (clip.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${seconds(clip.fadeIn)}`);
      if (clip.fadeOut > 0) chain.push(`afade=t=out:st=${seconds(length - clip.fadeOut)}:d=${seconds(clip.fadeOut)}`);
      chain.push(`adelay=${Math.round(clip.start * 1000)}:all=1`);
      filters.push(`[${sourceLabel}]${chain.join(",")}[audio${index}]`);
    });
    const audioInputs = audibleAudio.map((_, index) => `[audio${index}]`).join("");
    filters.push(`${audioInputs}amix=inputs=${audibleAudio.length}:duration=longest:normalize=0,apad=whole_dur=${seconds(duration)},atrim=duration=${seconds(duration)}[aout]`);
  }

  const args = [];
  for (const input of inputs) {
    if (input.title) args.push("-loop", "1", "-framerate", frameRate, "-t", seconds(duration));
    args.push("-i", input.path);
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audibleAudio.length > 0) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  const quality = preset === "archive-1080" ? "16" : "20";
  args.push(
    "-t", seconds(duration),
    "-r", frameRate,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", quality,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "framewave-export.mp4",
  );
  return { inputs, args, duration };
};
