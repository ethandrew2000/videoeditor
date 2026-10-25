const test = require("node:test");
const assert = require("node:assert/strict");
const loadProjectFormat = () => import("../src/project-format.mjs");

const media = [
  { id: "video-1", name: "scene.mp4", type: "video/mp4", size: 100, lastModified: 1, kind: "video", duration: 12 },
  { id: "audio-1", name: "music.wav", type: "audio/wav", size: 20, lastModified: 2, kind: "audio", duration: 8 },
];
const tracks = {
  video: [{ id: "V1", kind: "video", muted: false, solo: false, volume: 1 }],
  audio: [{ id: "A1", kind: "audio", muted: false, solo: false, volume: 1 }],
};
const clip = {
  id: "video-clip",
  mediaId: "video-1",
  kind: "video",
  trackId: "V1",
  start: 1,
  sourceStart: 2,
  sourceEnd: 5,
  volume: 1,
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
};
const settings = { previewVolume: 0.85, timelineZoom: 100, playheadTime: 0 };
const projectV2 = () => ({
  format: "framewave-project",
  version: 2,
  name: "Test edit",
  settings: { ...settings },
  media,
  timeline: { video: [{ ...clip }], audio: [] },
  tracks,
});

test("version 1 projects migrate sequential clips and default settings", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = {
    format: "framewave-project",
    version: 1,
    name: "Old edit",
    media,
    timeline: {
      video: [
        { id: "first", mediaId: "video-1", kind: "video", duration: 3, volume: 1, muted: false },
        { id: "second", mediaId: "video-1", kind: "video", duration: 2, volume: 1, muted: false },
      ],
      audio: [],
    },
  };
  const migrated = validateProject(project);
  assert.equal(migrated.version, 7);
  assert.deepEqual(migrated.timeline.video.map((item) => item.start), [0, 3]);
  assert.equal(migrated.settings.previewVolume, 0.85);
  assert.equal(migrated.settings.sequence.frameRate, 24);
});

test("version 2 projects keep edit positions and gain the current sequence defaults", async () => {
  const { validateProject } = await loadProjectFormat();
  const migrated = validateProject(projectV2());
  assert.equal(migrated.version, 7);
  assert.equal(migrated.timeline.video[0].start, 1);
  assert.equal(migrated.timeline.video[0].sourceStart, 2);
  assert.deepEqual(migrated.timeline.video[0].color, { brightness: 0, contrast: 1, saturation: 1, hue: 0 });
  assert.equal(migrated.timeline.video[0].title, "");
  assert.equal(migrated.settings.sequence.width, 1920);
});

test("version 3 projects migrate with unlinked clips by default", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 3;
  project.settings.sequence = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  project.timeline.video[0] = {
    ...clip,
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 },
    title: "",
  };
  const migrated = validateProject(project);
  assert.equal(migrated.version, 7);
  assert.equal(migrated.timeline.video[0].linkGroupId, null);
});

test("version 4 projects migrate with noise reduction disabled", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 4;
  project.settings.sequence = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  project.timeline.video[0] = {
    ...clip,
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 },
    title: "",
    linkGroupId: null,
  };
  project.timeline.audio.push({
    id: "audio-clip",
    mediaId: "audio-1",
    kind: "audio",
    trackId: "A1",
    start: 0,
    sourceStart: 0,
    sourceEnd: 4,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    linkGroupId: null,
  });
  const migrated = validateProject(project);
  assert.equal(migrated.version, 7);
  assert.equal(migrated.timeline.audio[0].noiseReduction, 0);
  assert.deepEqual(migrated.timeline.audio[0].autoTune, {
    enabled: false,
    key: 0,
    scale: "major",
    amount: 100,
  });
});

test("version 5 projects migrate with auto-tune disabled", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 5;
  project.settings.sequence = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  project.timeline.audio.push({
    id: "audio-clip",
    mediaId: "audio-1",
    kind: "audio",
    trackId: "A1",
    start: 0,
    sourceStart: 0,
    sourceEnd: 4,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    noiseReduction: 12,
  });
  const migrated = validateProject(project);
  assert.equal(migrated.version, 7);
  assert.equal(migrated.timeline.audio[0].noiseReduction, 12);
  assert.deepEqual(migrated.timeline.audio[0].autoTune, {
    enabled: false,
    key: 0,
    scale: "major",
    amount: 100,
  });
});

test("version 6 projects migrate with title defaults and retain fade transitions", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 6;
  project.settings.sequence = { width: 1280, height: 720, frameRate: 30, pixelAspect: 1 };
  project.timeline.video[0] = {
    ...clip,
    fadeIn: 0.25,
    fadeOut: 0.5,
    title: "Opening",
    color: { brightness: 0.1, contrast: 1.2, saturation: 0.8, hue: 45 },
  };
  project.timeline.audio.push({
    id: "audio-clip",
    mediaId: "audio-1",
    kind: "audio",
    trackId: "A1",
    start: 1,
    sourceStart: 0,
    sourceEnd: 3,
    volume: 1,
    noiseReduction: 18,
    autoTune: { enabled: true, key: 9, scale: "minor", amount: 72 },
    muted: false,
    linkGroupId: "linked-pair",
  });
  project.timeline.video[0].linkGroupId = "linked-pair";
  const validated = validateProject(project);
  assert.equal(validated.version, 7);
  assert.equal(validated.timeline.video[0].title, "Opening");
  assert.equal(validated.timeline.video[0].fadeOut, 0.5);
  assert.equal(validated.timeline.video[0].transitionIn, "fade");
  assert.equal(validated.timeline.video[0].transitionOut, "fade");
  assert.deepEqual(validated.timeline.video[0].titleStyle, {
    size: 7,
    family: "sans-serif",
    weight: 700,
    color: "#ffffff",
    position: "bottom-center",
    background: "none",
  });
  assert.equal(validated.timeline.video[0].linkGroupId, "linked-pair");
  assert.equal(validated.timeline.audio[0].linkGroupId, "linked-pair");
  assert.equal(validated.timeline.audio[0].noiseReduction, 18);
  assert.deepEqual(validated.timeline.audio[0].autoTune, {
    enabled: true,
    key: 9,
    scale: "minor",
    amount: 72,
  });
  assert.equal(validated.settings.sequence.width, 1280);
});

test("version 7 preserves title styles and explicit transition choices", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 7;
  project.settings.sequence = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  project.timeline.video[0] = {
    ...clip,
    fadeIn: 0.25,
    fadeOut: 0.5,
    title: "Opening",
    titleStyle: {
      size: 12,
      family: "serif",
      weight: 600,
      color: "#12abef",
      position: "top-right",
      background: "box",
    },
    transitionIn: "cut",
    transitionOut: "fade",
  };
  const validated = validateProject(project);
  assert.equal(validated.version, 7);
  assert.deepEqual(validated.timeline.video[0].titleStyle, project.timeline.video[0].titleStyle);
  assert.equal(validated.timeline.video[0].transitionIn, "cut");
  assert.equal(validated.timeline.video[0].transitionOut, "fade");
});

test("invalid references, source bounds, and odd sequence dimensions are rejected", async () => {
  const { validateProject } = await loadProjectFormat();
  const missingReference = projectV2();
  missingReference.timeline.video[0].mediaId = "missing";
  assert.throws(() => validateProject(missingReference), /invalid clip/);

  const invalidBounds = projectV2();
  invalidBounds.timeline.video[0].sourceEnd = 15;
  assert.throws(() => validateProject(invalidBounds), /invalid or duplicate/);

  const invalidSequence = projectV2();
  invalidSequence.version = 7;
  invalidSequence.settings.sequence = { width: 1919, height: 1080, frameRate: 24, pixelAspect: 1 };
  assert.throws(() => validateProject(invalidSequence), /sequence settings/);
});

test("invalid linked clip groups are rejected", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 7;
  project.timeline.video[0].linkGroupId = "broken-pair";
  assert.throws(() => validateProject(project), /linked clip group/);
});

test("invalid title and transition settings are rejected", async () => {
  const { validateProject } = await loadProjectFormat();
  const invalidTitle = projectV2();
  invalidTitle.version = 7;
  invalidTitle.timeline.video[0].titleStyle = {
    size: 7,
    family: "comic",
    weight: 700,
    color: "#ffffff",
    position: "bottom-center",
    background: "none",
  };
  assert.throws(() => validateProject(invalidTitle), /title or transition settings/);

  const invalidTransition = projectV2();
  invalidTransition.version = 7;
  invalidTransition.timeline.video[0].transitionOut = "wipe";
  assert.throws(() => validateProject(invalidTransition), /title or transition settings/);
});

test("noise reduction settings outside the supported range are rejected", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 7;
  project.settings.sequence = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  project.timeline.audio.push({
    id: "audio-clip",
    mediaId: "audio-1",
    kind: "audio",
    trackId: "A1",
    start: 0,
    sourceStart: 0,
    sourceEnd: 4,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    noiseReduction: 31,
  });
  assert.throws(() => validateProject(project), /invalid clip/);
});

test("invalid auto-tune settings are rejected", async () => {
  const { validateProject } = await loadProjectFormat();
  const project = projectV2();
  project.version = 7;
  project.settings.sequence = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  project.timeline.audio.push({
    id: "audio-clip",
    mediaId: "audio-1",
    kind: "audio",
    trackId: "A1",
    start: 0,
    sourceStart: 0,
    sourceEnd: 4,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    autoTune: { enabled: true, key: 12, scale: "major", amount: 100 },
  });
  assert.throws(() => validateProject(project), /audio effect settings/);
});
