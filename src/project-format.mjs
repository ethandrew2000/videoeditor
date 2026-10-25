const defaultColor = () => ({ brightness: 0, contrast: 1, saturation: 1, hue: 0 });
const defaultSequence = () => ({ width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 });
const defaultAutoTune = () => ({ enabled: false, key: 0, scale: "major", amount: 100 });
const defaultTitleStyle = () => ({
  size: 7,
  family: "sans-serif",
  weight: 700,
  color: "#ffffff",
  position: "bottom-center",
  background: "none",
});
const TITLE_POSITIONS = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export const validateProject = (value) => {
  if (!value || typeof value !== "object" || value.format !== "framewave-project" || ![1, 2, 3, 4, 5, 6, 7].includes(value.version)) {
    throw new Error("This is not a supported Framewave project (expected format version 1 through 7).");
  }
  if (typeof value.name !== "string" || !Array.isArray(value.media) || !value.timeline || typeof value.timeline !== "object") {
    throw new Error("The project file is missing required project data.");
  }

  const assetIds = new Set();
  const projectMedia = value.media.map((item) => {
    if (
      !item || typeof item.id !== "string" || item.id.length === 0 ||
      typeof item.name !== "string" || item.name.length === 0 ||
      !["audio", "video"].includes(item.kind) || typeof item.type !== "string" ||
      !Number.isFinite(item.size) || item.size < 0 ||
      !Number.isFinite(item.lastModified) || !Number.isFinite(item.duration) || item.duration < 0
    ) throw new Error("The project contains invalid source media details.");
    if (assetIds.has(item.id)) throw new Error("The project contains duplicate source media IDs.");
    assetIds.add(item.id);
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      size: item.size,
      lastModified: item.lastModified,
      kind: item.kind,
      duration: item.duration,
    };
  });

  const clipIds = new Set();
  const projectTracks = {
    video: value.version === 1 ? [{ id: "V1", kind: "video", muted: false, solo: false, volume: 1 }] : value.tracks?.video,
    audio: value.version === 1 ? [{ id: "A1", kind: "audio", muted: false, solo: false, volume: 1 }] : value.tracks?.audio,
  };
  const trackIds = new Set();
  const trackKinds = new Map();
  for (const kind of ["video", "audio"]) {
    if (!Array.isArray(projectTracks[kind]) || projectTracks[kind].length === 0 || projectTracks[kind].length > 16) {
      throw new Error(`The project has an invalid ${kind} track list.`);
    }
    projectTracks[kind] = projectTracks[kind].map((track) => {
      if (
        !track || typeof track.id !== "string" || track.id.length === 0 || track.kind !== kind ||
        !Number.isFinite(track.volume) || track.volume < 0 || track.volume > 1 ||
        typeof track.muted !== "boolean" || typeof track.solo !== "boolean" ||
        trackIds.has(track.id)
      ) throw new Error(`The project has an invalid ${kind} track.`);
      trackIds.add(track.id);
      trackKinds.set(track.id, kind);
      return { id: track.id, kind, muted: track.muted, solo: track.solo, volume: track.volume };
    });
  }

  const readTrack = (kind) => {
    if (!Array.isArray(value.timeline[kind])) throw new Error(`The project is missing its ${kind} track.`);
    let previousEnd = 0;
    return value.timeline[kind].map((clip) => {
      const start = value.version === 1 ? previousEnd : clip?.start;
      const sourceStart = value.version === 1 ? 0 : clip?.sourceStart;
      const sourceEnd = value.version === 1 ? clip?.duration : clip?.sourceEnd;
      const trackId = value.version === 1 ? projectTracks[kind][0].id : clip?.trackId;
      if (
        !clip || typeof clip.id !== "string" || clip.id.length === 0 ||
        clip.kind !== kind || !assetIds.has(clip.mediaId) ||
        !Number.isFinite(start) || start < 0 ||
        !Number.isFinite(sourceStart) || sourceStart < 0 ||
        !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart ||
        !Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 1 ||
        !Number.isFinite(clip.noiseReduction ?? 0) || (clip.noiseReduction ?? 0) < 0 || (clip.noiseReduction ?? 0) > 30 ||
        typeof clip.muted !== "boolean" || !trackIds.has(trackId) || trackKinds.get(trackId) !== kind ||
        !Number.isFinite(clip.fadeIn ?? 0) || (clip.fadeIn ?? 0) < 0 ||
        !Number.isFinite(clip.fadeOut ?? 0) || (clip.fadeOut ?? 0) < 0
      ) throw new Error(`The project contains an invalid clip on the ${kind} track.`);
      const source = projectMedia.find((item) => item.id === clip.mediaId);
      if (
        source.kind !== kind || clipIds.has(clip.id) ||
        (source.duration > 0 && sourceEnd > source.duration + 0.05) ||
        (clip.fadeIn ?? 0) + (clip.fadeOut ?? 0) > sourceEnd - sourceStart
      ) throw new Error("The project contains an invalid or duplicate timeline clip.");
      clipIds.add(clip.id);
      previousEnd = Math.max(previousEnd, start + sourceEnd - sourceStart);
      const color = clip.color ?? defaultColor();
      const autoTune = clip.autoTune ?? defaultAutoTune();
      const titleStyle = clip.titleStyle ?? defaultTitleStyle();
      if (
        !color || !Number.isFinite(color.brightness) || color.brightness < -1 || color.brightness > 1 ||
        !Number.isFinite(color.contrast) || color.contrast < 0 || color.contrast > 2 ||
        !Number.isFinite(color.saturation) || color.saturation < 0 || color.saturation > 2 ||
        !Number.isFinite(color.hue) || color.hue < 0 || color.hue >= 360 ||
        (clip.title !== undefined && (typeof clip.title !== "string" || clip.title.length > 256))
      ) throw new Error("The project contains invalid video effect settings.");
      if (kind === "video" && (
        !titleStyle || !Number.isFinite(titleStyle.size) || titleStyle.size < 2 || titleStyle.size > 18 ||
        !["sans-serif", "serif", "monospace"].includes(titleStyle.family) ||
        ![400, 600, 700].includes(titleStyle.weight) ||
        typeof titleStyle.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(titleStyle.color) ||
        !TITLE_POSITIONS.includes(titleStyle.position) ||
        !["none", "box"].includes(titleStyle.background) ||
        !["cut", "fade"].includes(clip.transitionIn ?? "cut") ||
        !["cut", "fade"].includes(clip.transitionOut ?? "cut")
      )) throw new Error("The project contains invalid title or transition settings.");
      if (kind === "audio" && (
        !autoTune || typeof autoTune.enabled !== "boolean" ||
        !Number.isInteger(autoTune.key) || autoTune.key < 0 || autoTune.key > 11 ||
        !["major", "minor", "chromatic"].includes(autoTune.scale) ||
        !Number.isFinite(autoTune.amount) || autoTune.amount < 0 || autoTune.amount > 100
      )) throw new Error("The project contains invalid audio effect settings.");
      return {
        id: clip.id,
        mediaId: clip.mediaId,
        kind,
        trackId,
        start,
        sourceStart,
        sourceEnd,
        linkGroupId: clip.linkGroupId ?? null,
        volume: clip.volume,
        noiseReduction: clip.noiseReduction ?? 0,
        ...(kind === "audio" ? { autoTune: { ...autoTune } } : {}),
        muted: clip.muted,
        fadeIn: clip.fadeIn ?? 0,
        fadeOut: clip.fadeOut ?? 0,
        color: { ...color },
        title: clip.title ?? "",
        ...(kind === "video" ? {
          titleStyle: { ...defaultTitleStyle(), ...titleStyle },
          transitionIn: clip.transitionIn ?? ((clip.fadeIn ?? 0) > 0 ? "fade" : "cut"),
          transitionOut: clip.transitionOut ?? ((clip.fadeOut ?? 0) > 0 ? "fade" : "cut"),
        } : {}),
      };

    });
  };

  const projectTimeline = { video: readTrack("video"), audio: readTrack("audio") };
  const linkGroups = new Map();
  for (const clip of [...projectTimeline.video, ...projectTimeline.audio]) {
    if (clip.linkGroupId === null) continue;
    if (typeof clip.linkGroupId !== "string" || clip.linkGroupId.length === 0) {
      throw new Error("The project contains an invalid linked clip group.");
    }
    const group = linkGroups.get(clip.linkGroupId) ?? [];
    group.push(clip);
    linkGroups.set(clip.linkGroupId, group);
  }
  for (const group of linkGroups.values()) {
    if (
      group.length !== 2 ||
      group[0].kind === group[1].kind
    ) throw new Error("Each linked clip group must contain one video clip and one audio clip.");
  }

  const projectSettings = value.settings ?? {};
  const volume = projectSettings.previewVolume ?? (value.version === 1 ? 0.85 : Number.NaN);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("The project contains invalid audio settings.");
  const zoom = projectSettings.timelineZoom ?? 100;
  if (!Number.isFinite(zoom) || zoom < 25 || zoom > 400) throw new Error("The project contains invalid timeline zoom.");
  const position = projectSettings.playheadTime ?? 0;
  if (!Number.isFinite(position) || position < 0) throw new Error("The project contains an invalid playhead position.");
  const inputSequence = projectSettings.sequence ?? defaultSequence();
  if (
    !inputSequence || !Number.isInteger(inputSequence.width) || inputSequence.width < 160 || inputSequence.width > 3840 ||
    inputSequence.width % 2 !== 0 ||
    !Number.isInteger(inputSequence.height) || inputSequence.height < 160 || inputSequence.height > 2160 || inputSequence.height % 2 !== 0 ||
    ![23.976, 24, 25, 29.97, 30, 50, 59.94, 60].includes(inputSequence.frameRate) ||
    ![1, 1.333333, 1.2, 1.066667, 0.888889].includes(inputSequence.pixelAspect)
  ) throw new Error("The project contains invalid sequence settings.");

  return {
    format: "framewave-project",
    version: 7,
    name: value.name,
    settings: {
      previewVolume: volume,
      timelineZoom: zoom,
      playheadTime: position,
      sequence: {
        width: inputSequence.width,
        height: inputSequence.height,
        frameRate: inputSequence.frameRate,
        pixelAspect: inputSequence.pixelAspect,
      },
    },
    media: projectMedia,
    timeline: projectTimeline,
    tracks: projectTracks,
    selection: value.selection && typeof value.selection === "object"
      ? { mediaId: value.selection.mediaId, clipId: value.selection.clipId }
      : { mediaId: null, clipId: null },
  };
};
