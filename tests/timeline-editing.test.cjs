const test = require("node:test");
const assert = require("node:assert/strict");
const { linkedClipPreview, rippleDelete, splitClipAt } = require("../src/timeline-editing.js");

const clip = (id, trackId, start, sourceStart, sourceEnd, linkGroupId = null) => ({
  id, trackId, start, sourceStart, sourceEnd, linkGroupId,
});

test("splitting preserves source alignment and separates fade sides", () => {
  const original = { ...clip("v1", "V1", 2, 3, 9), fadeIn: 0.5, fadeOut: 0.25 };
  const split = splitClipAt(original, 5, "v2");
  assert.ok(split);
  assert.equal(split[0].sourceEnd, 6);
  assert.equal(split[0].fadeIn, 0.5);
  assert.equal(split[0].fadeOut, 0);
  assert.equal(split[1].start, 5);
  assert.equal(split[1].sourceStart, 6);
  assert.equal(split[1].fadeIn, 0);
  assert.equal(split[1].fadeOut, 0.25);
  assert.equal(splitClipAt(original, 2, "edge"), null);
  assert.equal(splitClipAt(original, 8, "edge"), null);
});

test("ripple delete closes only gaps on the removed clip's track", () => {
  const clips = [
    clip("delete", "V1", 2, 0, 4),
    clip("later-v", "V1", 8, 0, 3),
    clip("audio", "A1", 8, 0, 3),
    clip("before", "V1", 1, 0, 1),
  ];
  const result = rippleDelete(clips, new Set(["delete"]));
  assert.equal(result.find((entry) => entry.id === "later-v").start, 4);
  assert.equal(result.find((entry) => entry.id === "audio").start, 8);
  assert.equal(result.find((entry) => entry.id === "before").start, 1);
  assert.equal(result.some((entry) => entry.id === "delete"), false);
});

test("ripple delete merges overlapping removed ranges before shifting clips", () => {
  const clips = [
    clip("first", "V1", 2, 0, 4),
    clip("second", "V1", 4, 0, 4),
    clip("later", "V1", 10, 0, 2),
  ];
  const result = rippleDelete(clips, new Set(["first", "second"]));
  assert.equal(result[0].start, 4);
});

test("linked clip preview applies move and trim deltas", () => {
  const video = clip("v", "V1", 2, 1, 7, "pair");
  const audio = clip("a", "A1", 2, 3, 8, "pair");
  assert.equal(linkedClipPreview(video, { ...video, start: 4 }, audio, "move").start, 4);
  const left = linkedClipPreview(video, { ...video, start: 3, sourceStart: 2 }, audio, "left");
  assert.equal(left.start, 3);
  assert.equal(left.sourceStart, 4);
  const right = linkedClipPreview(video, { ...video, sourceEnd: 6 }, audio, "right", 10);
  assert.equal(right.sourceEnd, 7);
});
