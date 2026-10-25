const test = require("node:test");
const assert = require("node:assert/strict");

const videoTrack = { id: "V1", muted: false, solo: false, volume: 1 };
const audioTracks = [
  { id: "A1", muted: false, solo: false, volume: 0.5 },
  { id: "A2", muted: false, solo: true, volume: 1 },
];
const videoClip = {
  id: "clip-1",
  mediaId: "video-1",
  kind: "video",
  trackId: "V1",
  start: 1,
  sourceStart: 2,
  sourceEnd: 5,
  fadeIn: 0.5,
  fadeOut: 0.25,
  color: { brightness: 0.1, contrast: 1.2, saturation: 0.8, hue: 30 },
  title: "A title",
  titleImage: new Blob(["png"]),
};
const audioClip = (id, mediaId, trackId, muted = false) => ({
  id, mediaId, kind: "audio", trackId, start: 0, sourceStart: 0, sourceEnd: 4,
  volume: 1, noiseReduction: 0, muted, fadeIn: 0.25, fadeOut: 0.5,
});

const sample = () => ({
  duration: 4,
  sequence: { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 },
  videoClips: [videoClip],
  audioClips: [audioClip("audio-muted", "audio-1", "A1"), audioClip("audio-solo", "audio-2", "A2")],
  videoTracks: [videoTrack],
  audioTracks,
  media: [
    { id: "video-1", name: "source.mp4", kind: "video", file: new Blob(["video"]) },
    { id: "audio-1", name: "muted.wav", kind: "audio", file: new Blob(["muted"]) },
    { id: "audio-2", name: "music.wav", kind: "audio", file: new Blob(["music"]) },
  ],
});

test("render plan trims, composes titles and color, and applies the sequence profile", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const plan = buildRenderPlan(sample());
  assert.equal(plan.inputs.length, 3);
  assert.ok(plan.args.includes("-filter_complex"));
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /trim=start=2:duration=3/);
  assert.match(graph, /eq=brightness=0\.1:contrast=1\.2:saturation=0\.8/);
  assert.match(graph, /overlay=eof_action=pass/);
  assert.match(plan.args.join(" "), /1920x1080/);
  assert.match(plan.args.join(" "), /-r 24/);
  assert.match(plan.args.join(" "), /-map \[aout\]/);
});

test("video title overlays share the clip transition and cut transitions suppress fades", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  input.videoClips[0].transitionIn = "cut";
  input.videoClips[0].transitionOut = "fade";
  const plan = buildRenderPlan(input);
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[video0\]\[title0\]overlay=x=0:y=0:eof_action=pass:shortest=0\[titled0\]/);
  assert.match(graph, /\[titled0\]fade=t=out:st=3\.75:d=0\.25:alpha=1\[video0f\]/);
  assert.doesNotMatch(graph, /\[titled0\]fade=t=in/);
});

test("render plan composites higher video tracks above lower tracks", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  input.media.push({ id: "video-2", name: "overlay.mp4", kind: "video", file: new Blob(["video"]) });
  input.videoTracks.push({ id: "V2", muted: false, solo: false, volume: 1 });
  input.videoClips.push({
    ...videoClip,
    id: "clip-2",
    mediaId: "video-2",
    trackId: "V2",
    title: "",
    titleImage: undefined,
    start: 1,
  });
  const plan = buildRenderPlan(input);
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.ok(graph.indexOf("[base0][video0f]overlay") < graph.indexOf("[base1][video1f]overlay"));
});

test("muted and non-solo audio tracks are excluded from the output mix", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  const mutedSource = input.media[1].file;
  input.media[1].file = null;
  const plan = buildRenderPlan(input);
  assert.equal(plan.inputs.filter((entry) => entry.kind === "audio").length, 1);
  assert.ok(!plan.inputs.some((entry) => entry.file === mutedSource));
});

test("render plan applies configurable noise reduction only to enabled audio clips", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  input.audioClips[1].noiseReduction = 18;
  const plan = buildRenderPlan(input);
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /atrim=start=0:duration=4,asetpts=PTS-STARTPTS,afftdn=nr=18:nf=-25,volume=1/);

  input.audioClips[1].noiseReduction = 0;
  const cleanPlan = buildRenderPlan(input);
  const cleanGraph = cleanPlan.args[cleanPlan.args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(cleanGraph, /afftdn/);
});

test("render plan exports Auto-Tune pitch changes across the trimmed source range", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  const clip = input.audioClips[1];
  clip.sourceStart = 0.25;
  clip.sourceEnd = 4;
  clip.autoTune = { enabled: true, key: 0, scale: "major", amount: 100 };
  const plan = buildRenderPlan({
    ...input,
    autoTuneEvents: new Map([[clip.id, [
      { time: 0.5, semitones: 1 },
      { time: 2, semitones: 0 },
    ]]]),
  });
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /atrim=start=0\.25:duration=0\.25,asetpts=PTS-STARTPTS/);
  assert.match(graph, /asetrate=50854,aresample=48000,atempo=0\.943879/);
  assert.match(graph, /concat=n=3:v=0:a=1\[tuned0\]/);
  assert.match(graph, /\[tuned0\]volume=1,afade=t=in:st=0:d=0\.25,afade=t=out:st=3\.25:d=0\.5,adelay=0:all=1\[audio0\]/);
});

test("render plan requires valid Auto-Tune analysis for enabled audible clips", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  input.audioClips[1].autoTune = { enabled: true, key: 0, scale: "major", amount: 100 };
  assert.throws(() => buildRenderPlan(input), /Auto-Tune analysis is missing/);
  assert.throws(() => buildRenderPlan({
    ...input,
    autoTuneEvents: new Map([[input.audioClips[1].id, [{ time: 2, semitones: 7 }]]]),
  }), /invalid pitch events/);
});

test("export rejects missing used sources and empty timelines", async () => {
  const { buildRenderPlan } = await import("../src/render-plan.mjs");
  const input = sample();
  input.media[0].file = null;
  assert.throws(() => buildRenderPlan(input), /Relink/);
  assert.throws(() => buildRenderPlan({ ...input, duration: 0 }), /Add clips/);
});
