const test = require("node:test");
const assert = require("node:assert/strict");
const { droppedFrameCount, frameIndexAtTime, frameTime, sequenceTimeAtClock } = require("../src/playback-clock.js");

test("playback clock maps sequence time onto frame boundaries", () => {
  const index = frameIndexAtTime(1.01, 24);
  assert.equal(index, 24);
  assert.equal(frameTime(index, 24), 1);
  assert.equal(frameIndexAtTime(1.01, 30), 30);
  assert.equal(frameIndexAtTime(-1, 24), 0);
});

test("playback clock advances from a shared wall-clock anchor in either direction", () => {
  const forward = { clockStart: 10, timelineStart: 3, rate: 1 };
  const reverse = { clockStart: 10, timelineStart: 3, rate: -2 };
  assert.equal(sequenceTimeAtClock(forward, 11.5), 4.5);
  assert.equal(sequenceTimeAtClock(reverse, 11.5), 0);
});

test("dropped-frame accounting counts only missing presented frames", () => {
  assert.equal(droppedFrameCount(12, 13), 0);
  assert.equal(droppedFrameCount(12, 16), 3);
  assert.equal(droppedFrameCount(16, 12), 0);
});
