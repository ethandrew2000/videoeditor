(() => {
  const clipEnd = (clip) => clip.start + clip.sourceEnd - clip.sourceStart;

  const splitClipAt = (clip, time, rightId) => {
    const splitTime = Math.min(clipEnd(clip), Math.max(clip.start, time));
    if (
      !Number.isFinite(splitTime) ||
      splitTime - clip.start < 0.05 ||
      clipEnd(clip) - splitTime < 0.05
    ) return null;

    const sourceSplit = clip.sourceStart + splitTime - clip.start;
    return [
      {
        ...clip,
        sourceEnd: sourceSplit,
        fadeOut: 0,
      },
      {
        ...clip,
        id: rightId,
        start: splitTime,
        sourceStart: sourceSplit,
        fadeIn: 0,
      },
    ];
  };

  const rippleDelete = (clips, removedIds) => {
    const removed = clips.filter((clip) => removedIds.has(clip.id));
    const intervalsByTrack = new Map();
    for (const clip of removed) {
      const intervals = intervalsByTrack.get(clip.trackId) ?? [];
      intervals.push({ start: clip.start, end: clipEnd(clip) });
      intervalsByTrack.set(clip.trackId, intervals);
    }
    for (const [trackId, intervals] of intervalsByTrack) {
      intervals.sort((left, right) => left.start - right.start);
      const merged = [];
      for (const interval of intervals) {
        const previous = merged.at(-1);
        if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
        else merged.push({ ...interval });
      }
      intervalsByTrack.set(trackId, merged);
    }
    return clips
      .filter((clip) => !removedIds.has(clip.id))
      .map((clip) => {
        const shift = (intervalsByTrack.get(clip.trackId) ?? [])
          .filter((interval) => clip.start >= interval.end - 0.001)
          .reduce((total, interval) => total + interval.end - interval.start, 0);
        return shift > 0 ? { ...clip, start: Math.max(0, clip.start - shift) } : clip;
      });
  };

  const linkedClipPreview = (clip, preview, linkedClip, handle, linkedDuration = Number.POSITIVE_INFINITY) => {
    if (handle === "move") {
      return { ...linkedClip, start: Math.max(0, linkedClip.start + preview.start - clip.start) };
    }
    if (handle === "left") {
      const delta = preview.start - clip.start;
      const sourceStart = Math.min(linkedClip.sourceEnd - 0.05, Math.max(0, linkedClip.sourceStart + delta));
      return {
        ...linkedClip,
        start: Math.max(0, linkedClip.start + sourceStart - linkedClip.sourceStart),
        sourceStart,
      };
    }
    if (handle === "right") {
      const durationDelta = (preview.sourceEnd - preview.sourceStart) - (clip.sourceEnd - clip.sourceStart);
      const sourceEnd = Math.min(
        linkedDuration,
        Math.max(linkedClip.sourceStart + 0.05, linkedClip.sourceEnd + durationDelta),
      );
      return { ...linkedClip, sourceEnd };
    }
    return linkedClip;
  };

  const core = { clipEnd, splitClipAt, rippleDelete, linkedClipPreview };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof window !== "undefined") window.FramewaveEditing = core;
})();
