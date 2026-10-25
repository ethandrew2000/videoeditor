const test = require("node:test");
const assert = require("node:assert/strict");

test("source separation creates silent video and audio-only outputs", async () => {
  const { buildSourceSeparationPlan } = await import("../src/source-separation.mjs");
  const plan = buildSourceSeparationPlan({
    kind: "video",
    name: "My clip.mov",
    file: new Blob(["video"]),
  });

  assert.equal(plan.inputPath, "separation-source.mov");
  assert.equal(plan.videoName, "My clip-video-only.mp4");
  assert.equal(plan.audioName, "My clip-audio.m4a");
  assert.ok(plan.videoArgs.includes("-an"));
  assert.ok(plan.videoArgs.includes("0:v:0"));
  assert.ok(plan.audioArgs.includes("-vn"));
  assert.ok(plan.audioArgs.includes("0:a:0"));
  assert.equal(plan.videoArgs.at(-1), plan.videoPath);
  assert.equal(plan.audioArgs.at(-1), plan.audioPath);
});

test("source separation rejects missing media and sanitizes output names", async () => {
  const { buildSourceSeparationPlan } = await import("../src/source-separation.mjs");
  assert.throws(() => buildSourceSeparationPlan(null), /Select an available video/);
  assert.throws(() => buildSourceSeparationPlan({ kind: "audio", file: new Blob() }), /Select an available video/);
  assert.throws(() => buildSourceSeparationPlan({ kind: "video", file: null }), /Select an available video/);

  const plan = buildSourceSeparationPlan({
    kind: "video",
    name: "../scene: take?.mov",
    file: new Blob(["video"]),
  });
  assert.equal(plan.videoName, "scene- take--video-only.mp4");
  assert.equal(plan.audioName, "scene- take--audio.m4a");
});
