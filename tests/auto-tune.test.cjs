const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzePitch,
  buildAutoTuneEvents,
  getCorrectionSemitones,
  PITCH_FRAME_HOP_SECONDS,
  PITCH_SAMPLE_RATE,
} = require("../src/auto-tune.mjs");

const tone = (frequency, seconds = 0.5, sampleRate = PITCH_SAMPLE_RATE) => {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.7 * Math.sin(2 * Math.PI * frequency * index / sampleRate);
  }
  return samples;
};

test("pitch analysis finds a steady vocal fundamental and ignores silence", () => {
  const frames = analyzePitch(tone(440));
  const voiced = [];
  for (let index = 0; index < frames.length; index += 2) {
    if (frames[index + 1] >= 0.6) voiced.push(frames[index]);
  }
  assert.ok(voiced.length > 5);
  assert.ok(voiced.every((frequency) => Math.abs(frequency - 440) < 5));
  assert.equal(analyzePitch(new Float32Array(4096)).some((value) => value > 0), false);
});

test("pitch correction targets notes in the selected scale and respects strength", () => {
  assert.ok(Math.abs(getCorrectionSemitones(415.3, 0, "major", 100) + 0.99) < 0.08);
  assert.equal(getCorrectionSemitones(440, 0, "major", 100), 0);
  assert.ok(Math.abs(getCorrectionSemitones(415.3, 0, "major", 50) + 0.495) < 0.05);
  assert.equal(getCorrectionSemitones(415.3, 0, "chromatic", 100), 0);
});

test("auto-tune events include only note changes within the trimmed source range", () => {
  const frames = analyzePitch(tone(415.3, 0.5));
  const events = buildAutoTuneEvents(frames, { key: 0, scale: "major", amount: 100 }, 0.1, 0.4);
  assert.ok(events.length > 0);
  assert.ok(events.length < 4);
  assert.ok(events.every((event) => event.time >= 0.1 && event.time < 0.4));
  assert.ok(events.every((event) => Math.abs(event.semitones) > 0.8 && Math.abs(event.semitones) < 1.2));
  assert.ok(PITCH_FRAME_HOP_SECONDS > 0);
});
