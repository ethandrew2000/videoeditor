(() => {
  const clipEnd = (clip) => clip.start + clip.sourceEnd - clip.sourceStart;

  const timelineEnd = (clips) => clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);

  const activeVideoClipsAtTime = (clips, tracks, time) => {
    const trackOrder = new Map(tracks.map((track, index) => [track.id, index]));
    return clips
      .filter((clip) => time >= clip.start && time < clipEnd(clip) && trackOrder.has(clip.trackId))
      .map((clip) => ({ clip, trackIndex: trackOrder.get(clip.trackId) }))
      .sort((left, right) => left.trackIndex - right.trackIndex || left.clip.start - right.clip.start);
  };

  const snapTime = (value, clips, excludeId, threshold = 0.18, grid = 0.25) => {
    const candidates = [Math.round(value / grid) * grid];
    for (const clip of clips) {
      if (clip.id === excludeId) continue;
      candidates.push(clip.start, clipEnd(clip));
    }
    const nearest = candidates.reduce((best, candidate) =>
      Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, candidates[0]);
    return Math.abs(nearest - value) <= threshold ? Math.max(0, nearest) : Math.max(0, value);
  };

  const moveClip = (clip, start, sourceClips, snap = true) => ({
    ...clip,
    start: snap ? snapTime(start, sourceClips, clip.id) : Math.max(0, start),
  });

  const trimClip = (clip, edge, timelineTime, sourceDuration, snap = true, peers = []) => {
    const duration = clip.sourceEnd - clip.sourceStart;
    const snappedTime = snap ? snapTime(timelineTime, peers, clip.id) : timelineTime;
    if (edge === "left") {
      const delta = snappedTime - clip.start;
      const sourceStart = Math.max(0, Math.min(clip.sourceEnd - 0.05, clip.sourceStart + delta));
      return { ...clip, start: Math.max(0, clip.start + sourceStart - clip.sourceStart), sourceStart };
    }
    if (edge === "right") {
      const sourceEnd = Math.max(clip.sourceStart + 0.05, Math.min(sourceDuration, clip.sourceStart + snappedTime - clip.start));
      return { ...clip, sourceEnd };
    }
    return clip;
  };

  const core = { clipEnd, timelineEnd, activeVideoClipsAtTime, snapTime, moveClip, trimClip };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof window !== "undefined") window.FramewaveTimeline = core;
})();
