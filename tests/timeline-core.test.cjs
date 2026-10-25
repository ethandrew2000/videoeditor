const test = require("node:test");
const assert = require("node:assert/strict");
const { activeVideoClipsAtTime, clipEnd, moveClip, snapTime, timelineEnd, trimClip } = require("../src/timeline-core.js");

const clips = [
  { id: "one", start: 0, sourceStart: 2, sourceEnd: 7 },
  { id: "two", start: 8, sourceStart: 0, sourceEnd: 3 },
];

test("clip end and track end respect timeline positions and source trims", () => {
  assert.equal(clipEnd(clips[0]), 5);
  assert.equal(timelineEnd(clips), 11);
});

test("active video clips are composited bottom-to-top in track and clip order", () => {
  const tracks = [{ id: "V1" }, { id: "V2" }];
  const videoClips = [
    { ...clips[0], trackId: "V2", start: 0 },
    { ...clips[1], trackId: "V1", start: 1 },
    { ...clips[1], id: "overlap", trackId: "V1", start: 2 },
  ];
  assert.deepEqual(activeVideoClipsAtTime(videoClips, tracks, 2.5).map(({ clip }) => clip.id), ["two", "overlap", "one"]);
  assert.deepEqual(activeVideoClipsAtTime(videoClips, tracks, 10), []);
});

test("clip moves snap to a nearby clip edge and never start before zero", () => {
  assert.equal(moveClip(clips[1], 5.1, clips).start, 5);
  assert.equal(moveClip(clips[1], -4, clips, false).start, 0);
});

test("snap includes the quarter-second grid and other clip boundaries", () => {
  assert.equal(snapTime(2.1, clips, "one"), 2);
  assert.equal(snapTime(4.26, [], "none"), 4.25);
  assert.equal(snapTime(4.4, [], "none", 0.05), 4.4);
});

test("left trim advances source in-point and keeps the right edge fixed", () => {
  const trimmed = trimClip(clips[0], "left", 3, 10, false);
  assert.equal(trimmed.start, 3);
  assert.equal(trimmed.sourceStart, 5);
  assert.equal(clipEnd(trimmed), clipEnd(clips[0]));
});

test("right trim stays within source duration and preserves a minimum duration", () => {
  const trimmed = trimClip(clips[0], "right", 20, 8, false);
  assert.equal(trimmed.sourceEnd, 8);
  const minimum = trimClip(clips[0], "right", 0, 8, false);
  assert.ok(Math.abs(minimum.sourceEnd - minimum.sourceStart - 0.05) < 1e-9);
});
