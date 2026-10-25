(() => {
  const frameIndexAtTime = (time, frameRate) => Math.max(0, Math.round(time * frameRate));
  const frameTime = (index, frameRate) => index / frameRate;
  const sequenceTimeAtClock = ({ clockStart, timelineStart, rate }, now) =>
    timelineStart + Math.max(0, now - clockStart) * rate;
  const droppedFrameCount = (previousPresentedFrames, presentedFrames) =>
    Math.max(0, presentedFrames - previousPresentedFrames - 1);

  const clock = { frameIndexAtTime, frameTime, sequenceTimeAtClock, droppedFrameCount };
  if (typeof module !== "undefined" && module.exports) module.exports = clock;
  if (typeof window !== "undefined") window.FramewavePlaybackClock = clock;
})();
