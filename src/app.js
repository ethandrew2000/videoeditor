import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import SignalsmithStretch from "signalsmith-stretch";
import ffmpegCoreURL from "@ffmpeg/core?url";
import ffmpegWasmURL from "@ffmpeg/core/wasm?url";
import "./playback-clock.js";
import "./timeline-core.js";
import "./timeline-editing.js";
import {
  buildAutoTuneEvents,
  getCorrectionSemitones,
  PITCH_FRAME_HOP_SECONDS,
  PITCH_FRAME_OFFSET_SECONDS,
  PITCH_SAMPLE_RATE,
} from "./auto-tune.mjs";
import { buildRenderPlan } from "./render-plan.mjs";
import { buildSourceSeparationPlan } from "./source-separation.mjs";
import { validateProject } from "./project-format.mjs";

(() => {
  const media = [];
  const timeline = { video: [], audio: [] };
  const sequenceSettings = { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 };
  const tracks = {
    video: [{ id: "V1", kind: "video", muted: false, solo: false, volume: 1 }],
    audio: [{ id: "A1", kind: "audio", muted: false, solo: false, volume: 1 }],
  };
  const elements = {
    audioArtwork: document.querySelector("#audio-artwork"),
    audioPreview: document.querySelector("#audio-preview"),
    audioSourceName: document.querySelector("#audio-source-name"),
    allCount: document.querySelector("#all-count"),
    workspace: document.querySelector(".workspace"),
    currentTime: document.querySelector("#current-time"),
    durationTime: document.querySelector("#duration-time"),
    emptyLibrary: document.querySelector("#empty-library"),
    emptyImport: document.querySelector("#empty-import"),
    fileInput: document.querySelector("#file-input"),
    inspector: document.querySelector("#inspector-content"),
    librarySummary: document.querySelector("#library-summary"),
    mediaList: document.querySelector("#media-list"),
    muteButton: document.querySelector("#mute-button"),
    openProject: document.querySelector("#open-project"),
    playButton: document.querySelector("#play-button"),
    playhead: document.querySelector("#playhead"),
    trackRows: document.querySelector("#track-rows"),
    projectInput: document.querySelector("#project-input"),
    projectName: document.querySelector("#project-name"),
    saveProject: document.querySelector("#save-project"),
    saveStatus: document.querySelector("#save-status"),
    searchInput: document.querySelector("#search-input"),
    seekSlider: document.querySelector("#seek-slider"),
    timelineRuler: document.querySelector("#timeline-ruler"),
    timelineSummary: document.querySelector("#timeline-summary"),
    timelineCanvas: document.querySelector("#timeline-canvas"),
    exportStatus: document.querySelector("#export-status"),
    exportProgress: document.querySelector("#export-progress"),
    cancelExport: document.querySelector("#cancel-export"),
    exportPreset: document.querySelector("#export-preset"),
    videoPreview: document.querySelector("#video-preview"),
    videoTitleOverlay: document.querySelector("#video-title-overlay"),
    viewerStage: document.querySelector("#viewer-stage"),
    viewerEmpty: document.querySelector("#viewer-empty"),
    viewerSource: document.querySelector("#viewer-source"),
    viewerTimecode: document.querySelector("#viewer-timecode"),
    volumeSlider: document.querySelector("#volume-slider"),
  };

  const engine = window.FramewaveTimeline;
  const playbackClock = window.FramewavePlaybackClock;
  const editing = window.FramewaveEditing;
  if (!engine) throw new Error("The Framewave timeline engine failed to load.");
  if (!playbackClock) throw new Error("The Framewave playback clock failed to load.");
  if (!editing) throw new Error("The Framewave editing tools failed to load.");

  let selectedMediaId = null;
  let selectedClipId = null;
  let selectedClipIds = new Set();
  let selectedTrackId = null;
  let activeSource = null;
  let activeFilter = "all";
  let saveTimer = null;
  let databasePromise = null;
  let restoring = true;
  let timelineZoom = 100;
  let playheadTime = 0;
  let sequencePlaying = false;
  let playbackRate = 1;
  let playbackFrame = 0;
  let sequenceClock = null;
  let droppedVideoFrames = 0;
  let droppedFrameReportingAvailable = true;
  const observedVideoFrames = new WeakMap();
  let audioScheduleToken = 0;
  let activeVideoClipId = null;
  const previewLayers = new Map();
  let dragState = null;
  let audioContext = null;
  let masterGain = null;
  let masterMuted = false;
  let audioMeterFrame = 0;
  const audioBuffers = new Map();
  const audioPlayers = new Map();
  const autoTuneNodes = new Map();
  const pitchCurves = new Map();
  const pitchJobs = new Map();
  const pitchRequests = new Map();
  const waveformCache = new Map();
  const waveformJobs = new Map();
  const undoStack = [];
  const redoStack = [];
  let pitchWorker = null;
  let pitchRequestId = 0;
  let ffmpeg = null;
  let exporting = false;
  let exportCancelled = false;
  let ffmpegProgressLabel = "Rendering";
  let separationResult = null;

  const defaultColor = () => ({ brightness: 0, contrast: 1, saturation: 1, hue: 0 });
  const defaultTitleStyle = () => ({
    size: 7,
    family: "sans-serif",
    weight: 700,
    color: "#ffffff",
    position: "bottom-center",
    background: "none",
  });
  const defaultAutoTune = () => ({ enabled: false, key: 0, scale: "major", amount: 100 });
  const autoTuneKeys = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const applyTitleStyle = (element, clip, opacity = 1) => {
    const titleStyle = { ...defaultTitleStyle(), ...clip.titleStyle };
    element.textContent = clip.title ?? "";
    element.hidden = !clip.title;
    element.dataset.position = titleStyle.position;
    element.style.setProperty("--title-size", titleStyle.size);
    element.style.fontFamily = titleStyle.family;
    element.style.fontWeight = String(titleStyle.weight);
    element.style.color = titleStyle.color;
    element.style.backgroundColor = titleStyle.background === "box" ? "rgba(0, 0, 0, 0.58)" : "transparent";
    element.style.opacity = String(opacity);
    const [vertical, horizontal] = titleStyle.position === "center"
      ? ["center", "center"]
      : titleStyle.position.match(/^(top|center|bottom)-(left|center|right)$/)?.slice(1) ?? ["bottom", "center"];
    element.style.top = vertical === "top" ? "10%" : vertical === "center" ? "50%" : "auto";
    element.style.bottom = vertical === "bottom" ? "12%" : "auto";
    element.style.left = horizontal === "left" ? "8%" : horizontal === "center" ? "50%" : "auto";
    element.style.right = horizontal === "right" ? "8%" : "auto";
    element.style.textAlign = horizontal === "left" ? "left" : horizontal === "right" ? "right" : "center";
    element.style.transform = `${horizontal === "center" ? "translateX(-50%)" : ""}${vertical === "center" ? " translateY(-50%)" : ""}`.trim() || "none";
  };
  const applyVideoClipStyle = (clip) => {
    if (!clip) {
      elements.videoPreview.style.filter = "none";
      elements.videoPreview.style.opacity = "1";
      elements.videoTitleOverlay.hidden = true;
      return;
    }
    const color = clip.color ?? defaultColor();
    elements.videoPreview.style.filter = `brightness(${1 + color.brightness}) contrast(${color.contrast}) saturate(${color.saturation}) hue-rotate(${color.hue}deg)`;
    applyTitleStyle(elements.videoTitleOverlay, clip);
  };
  const clearPreviewLayers = () => {
    for (const layer of previewLayers.values()) {
      layer.video.pause();
      layer.video.removeAttribute("src");
      layer.video.load();
      layer.wrapper.remove();
    }
    previewLayers.clear();
  };

  const openDatabase = () => {
    if (!("indexedDB" in window)) return Promise.reject(new Error("This browser does not support local project storage."));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("framewave-studio", 1);
        request.addEventListener("upgradeneeded", () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("projects")) database.createObjectStore("projects", { keyPath: "key" });
          if (!database.objectStoreNames.contains("assets")) database.createObjectStore("assets", { keyPath: "id" });
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error ?? new Error("Could not open local project storage.")));
        request.addEventListener("blocked", () => reject(new Error("Local project storage is blocked by another open editor tab.")));
      });
    }
    return databasePromise;
  };

  const runTransaction = async (storeNames, mode, operation) => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeNames, mode);
      let result;
      transaction.addEventListener("complete", () => resolve(result), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Local project storage failed.")), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Local project storage was interrupted.")), { once: true });
      try {
        result = operation(transaction);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  };

  const readRecord = (storeName, key) => runTransaction([storeName], "readonly", (transaction) => {
    let result;
    const request = transaction.objectStore(storeName).get(key);
    request.addEventListener("success", () => { result = request.result; });
    return () => result;
  }).then((getResult) => getResult());

  const writeProjectToStorage = () => {
    if (media.some((item) => item.file && !item.storageReady)) {
      return Promise.reject(new Error("An imported media file could not be cached. Remove and re-import it before relying on autosave."));
    }
    return runTransaction(["projects"], "readwrite", (transaction) => {
      transaction.objectStore("projects").put({ key: "current", project: serializeProject() });
    });
  };

  const writeAssetsToStorage = (items) => runTransaction(["assets"], "readwrite", (transaction) => {
    for (const item of items) {
      if (!item.file) continue;
      transaction.objectStore("assets").put({
        id: item.id,
        name: item.name,
        type: item.type,
        size: item.size,
        lastModified: item.lastModified,
        file: item.file,
      });
    }
  });

  const setSaveStatus = (status) => {
    elements.saveStatus.textContent = status;
    elements.saveStatus.title = status === "STORAGE ERROR"
      ? "Project changes could not be saved in this browser."
      : "Autosave is stored in this browser profile.";
  };

  const handleStorageError = (error) => {
    console.error("Framewave local project storage error:", error);
    setSaveStatus("STORAGE ERROR");
    showToast(`Could not save this project in the browser: ${error.message}`);
  };

  const scheduleAutosave = () => {
    setSaveStatus("UNSAVED");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      writeProjectToStorage().then(() => setSaveStatus("AUTOSAVED")).catch(handleStorageError);
    }, 500);
  };

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  };

  const formatTimecode = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00:00";
    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = wholeSeconds % 60;
    const frames = Math.floor((seconds % 1) * sequenceSettings.frameRate);
    return [hours, minutes, remainder, frames].map((value) => String(value).padStart(2, "0")).join(":");
  };

  const formatSize = (bytes) => {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const createId = (prefix) => {
    const suffix = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${suffix}`;
  };

  const isVideo = (file) => file.type.startsWith("video/");

  const sourceElement = () => (activeSource?.kind === "video" ? elements.videoPreview : elements.audioPreview);

  const serializeProject = () => ({
    format: "framewave-project",
    version: 7,
    name: elements.projectName.textContent || "Untitled project",
    updatedAt: new Date().toISOString(),
    settings: {
      previewVolume: Number(elements.volumeSlider.value),
      timelineZoom,
      playheadTime,
      sequence: { ...sequenceSettings },
    },
    media: media.map(({ id, name, type, size, lastModified, kind, duration }) => ({
      id, name, type, size, lastModified, kind, duration,
    })),
    timeline: {
      video: timeline.video.map((clip) => ({
        ...clip,
        titleStyle: { ...defaultTitleStyle(), ...clip.titleStyle },
      })),
      audio: timeline.audio.map((clip) => ({ ...clip })),
    },
    tracks: {
      video: tracks.video.map((track) => ({ ...track })),
      audio: tracks.audio.map((track) => ({ ...track })),
    },
    selection: { mediaId: selectedMediaId, clipId: selectedClipId },
  });

  const updateHistoryButtons = () => {
    document.querySelector("#undo-button").disabled = undoStack.length === 0;
    document.querySelector("#redo-button").disabled = redoStack.length === 0;
  };

  const recordUndo = () => {
    undoStack.push(serializeProject());
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  };

  const restoreHistory = async (source, destination, label) => {
    const snapshot = source.pop();
    if (!snapshot) return;
    destination.push(serializeProject());
    updateHistoryButtons();
    try {
      await applyProject(snapshot, false);
      updateHistoryButtons();
      showToast(`${label}.`);
    } catch (error) {
      source.push(snapshot);
      destination.pop();
      updateHistoryButtons();
      throw error;
    }
  };

  const setShuttlePlayback = async (direction) => {
    if (sequenceDuration() <= 0) {
      showToast("Add a clip to the timeline to use J/K/L shuttle playback.");
      return;
    }
    const sameDirection = sequencePlaying && Math.sign(playbackRate) === direction;
    const nextRate = sameDirection ? Math.min(4, Math.abs(playbackRate) * 2) * direction : direction;
    if (sequencePlaying) pauseSequence();
    playbackRate = nextRate;
    playheadTime = direction < 0 && playheadTime <= 0 ? sequenceDuration() : playheadTime;
    if (direction > 0 && playheadTime >= sequenceDuration()) playheadTime = 0;
    if (!sequencePlaying) droppedVideoFrames = 0;
    sequencePlaying = true;
    elements.playButton.textContent = "Ⅱ";
    elements.playButton.setAttribute("aria-label", "Pause");
    updatePlaybackMode();
    await startSequence();
  };

  const stepFrame = (direction) => {
    if (sequencePlaying) pauseSequence();
    const frameDuration = 1 / sequenceSettings.frameRate;
    if (sequenceDuration() > 0) {
      setPlayhead(playheadTime + direction * frameDuration);
      return;
    }
    const element = sourceElement();
    if (activeSource && Number.isFinite(element.duration)) {
      element.pause();
      element.currentTime = Math.max(0, Math.min(element.duration, element.currentTime + direction * frameDuration));
    }
  };

  const updateMuteButton = (muted) => {
    elements.muteButton.setAttribute("aria-label", muted ? "Unmute preview" : "Mute preview");
    elements.muteButton.textContent = muted ? "◌" : "◖";
  };

  const ensureAudioContext = () => {
    if (audioContext) return audioContext;
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support the Web Audio API.");
    audioContext = new AudioContextClass({ sampleRate: 48000 });
    masterGain = audioContext.createGain();
    masterGain.gain.value = Number(elements.volumeSlider.value);
    masterGain.connect(audioContext.destination);
    return audioContext;
  };

  const ensureWaveform = (item) => {
    if (item.kind !== "audio" || !item.file || waveformCache.has(item.id)) return Promise.resolve();
    if (waveformJobs.has(item.id)) return waveformJobs.get(item.id);
    if (item.size > 80 * 1024 * 1024) {
      showToast(`Audio decoding is unavailable for ${item.name}: files over 80 MB exceed this browser editor's limit.`);
      return Promise.resolve();
    }
    const job = (async () => {
      try {
        const context = ensureAudioContext();
        const buffer = await context.decodeAudioData(await item.file.arrayBuffer());
        audioBuffers.set(item.id, buffer);
        const peaks = new Float32Array(320);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
        for (let bucket = 0; bucket < peaks.length; bucket += 1) {
          const from = Math.floor(bucket * buffer.length / peaks.length);
          const to = Math.max(from + 1, Math.floor((bucket + 1) * buffer.length / peaks.length));
          let peak = 0;
          for (const channel of channels) {
            for (let sample = from; sample < Math.min(to, buffer.length); sample += 1) {
              peak = Math.max(peak, Math.abs(channel[sample]));
            }
          }
          peaks[bucket] = peak;
        }
        waveformCache.set(item.id, peaks);
        renderTimeline();
      } catch (error) {
        console.error(`Could not decode waveform for ${item.name}:`, error);
        showToast(`Could not decode waveform for ${item.name}: ${error.message}`);
      }
    })().finally(() => waveformJobs.delete(item.id));
    waveformJobs.set(item.id, job);
    return job;
  };

  const getPitchAnalysisWorker = () => {
    if (pitchWorker) return pitchWorker;
    const worker = new Worker(new URL("./pitch-analysis-worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      const request = pitchRequests.get(event.data.id);
      if (!request) return;
      pitchRequests.delete(event.data.id);
      if (event.data.error) {
        request.reject(new Error(event.data.error));
        return;
      }
      pitchCurves.set(request.mediaId, event.data.frames);
      request.resolve(event.data.frames);
    });
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The pitch-analysis worker failed.");
      for (const request of pitchRequests.values()) request.reject(error);
      pitchRequests.clear();
      worker.terminate();
      if (pitchWorker === worker) pitchWorker = null;
    });
    pitchWorker = worker;
    return worker;
  };

  const ensurePitchCurve = (item, buffer = audioBuffers.get(item.id)) => {
    if (pitchCurves.has(item.id)) return Promise.resolve(pitchCurves.get(item.id));
    if (pitchJobs.has(item.id)) return pitchJobs.get(item.id);
    if (!buffer) return Promise.reject(new Error(`Could not decode ${item.name} for Auto-Tune analysis.`));

    const inputSamplesPerOutput = buffer.sampleRate / PITCH_SAMPLE_RATE;
    const channelData = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
    const sampleCount = Math.floor(buffer.length / inputSamplesPerOutput);
    const mono = new Float32Array(sampleCount);
    for (let outputIndex = 0; outputIndex < sampleCount; outputIndex += 1) {
      const start = Math.floor(outputIndex * inputSamplesPerOutput);
      const end = Math.min(buffer.length, Math.floor((outputIndex + 1) * inputSamplesPerOutput));
      let total = 0;
      let count = 0;
      for (const channel of channelData) {
        for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
          total += channel[inputIndex];
          count += 1;
        }
      }
      mono[outputIndex] = total / count;
    }

    const job = new Promise((resolve, reject) => {
      const id = ++pitchRequestId;
      pitchRequests.set(id, { mediaId: item.id, resolve, reject });
      try {
        getPitchAnalysisWorker().postMessage({ id, samples: mono, sampleRate: PITCH_SAMPLE_RATE }, [mono.buffer]);
      } catch (error) {
        pitchRequests.delete(id);
        reject(error);
      }
    }).finally(() => pitchJobs.delete(item.id));
    pitchJobs.set(item.id, job);
    return job;
  };

  const ensureAutoTuneNode = async (clip, buffer, context) => {
    if (!window.isSecureContext || !context.audioWorklet || typeof window.AudioWorkletNode !== "function") {
      throw new Error("Live Auto-Tune needs AudioWorklet in a secure browser context. Open this app on localhost or through trusted HTTPS.");
    }
    if (buffer.sampleRate !== context.sampleRate) {
      throw new Error("This browser decoded the audio at an unsupported sample rate for live Auto-Tune.");
    }
    const cached = autoTuneNodes.get(clip.id);
    if (cached?.mediaId === clip.mediaId && cached.channelCount === Math.min(buffer.numberOfChannels, 2)) {
      return cached.node;
    }
    if (cached) {
      cached.node.disconnect();
      autoTuneNodes.delete(clip.id);
    }

    const channelCount = Math.min(buffer.numberOfChannels, 2);
    const node = await SignalsmithStretch(context, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channelCount],
    });
    try {
      const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index).slice());
      await node.addBuffers(channels, channels.map((channel) => channel.buffer));
    } catch (error) {
      node.disconnect();
      throw error;
    }
    autoTuneNodes.set(clip.id, { node, mediaId: clip.mediaId, channelCount });
    return node;
  };

  const clearAutoTuneNodes = () => {
    for (const { node } of autoTuneNodes.values()) {
      node.disconnect();
    }
    autoTuneNodes.clear();
  };

  const clearPitchAnalysis = () => {
    pitchWorker?.terminate();
    pitchWorker = null;
    for (const request of pitchRequests.values()) request.reject(new Error("The project changed during pitch analysis."));
    pitchRequests.clear();
    pitchJobs.clear();
    pitchCurves.clear();
  };

  const correctionAtSourceTime = (frames, time, settings) => {
    const index = Math.max(0, Math.floor((time - PITCH_FRAME_OFFSET_SECONDS) / PITCH_FRAME_HOP_SECONDS));
    const frequency = frames[index * 2];
    const confidence = frames[index * 2 + 1];
    return confidence >= 0.6 ? getCorrectionSemitones(frequency, settings.key, settings.scale, settings.amount) : 0;
  };

  const scheduleAutoTune = async (node, clip, sourceOffset, playDuration, scheduledAt) => {
    const frames = pitchCurves.get(clip.mediaId);
    if (!frames) throw new Error("Auto-Tune pitch analysis is not ready. Wait for analysis to finish and try again.");
    const endAt = scheduledAt + playDuration;
    const initialSemitones = correctionAtSourceTime(frames, sourceOffset, clip.autoTune);
    await node.schedule({
      active: true,
      input: sourceOffset,
      output: scheduledAt,
      outputTime: scheduledAt,
      rate: 1,
      semitones: initialSemitones,
    });
    const events = buildAutoTuneEvents(frames, clip.autoTune, sourceOffset, sourceOffset + playDuration)
      .filter((event) => Math.abs(event.semitones - initialSemitones) >= 0.15);
    await Promise.all(events.map((event) => {
      const output = scheduledAt + event.time - sourceOffset;
      return node.schedule({
        output,
        outputTime: output,
        semitones: event.semitones,
      });
    }));
    await node.schedule({ active: false, output: endAt, outputTime: endAt });
  };

  const audioTrackIsAudible = (track) => {
    const hasSolo = tracks.audio.some((entry) => entry.solo);
    return !track.muted && (!hasSolo || track.solo);
  };

  const refreshAudioGains = () => {
    for (const player of audioPlayers.values()) {
      const track = tracks.audio.find((entry) => entry.id === player.trackId);
      if (!track) continue;
      const audible = audioTrackIsAudible(track) && !player.clip.muted;
      player.gain.gain.setTargetAtTime(
        audible ? player.clip.volume * track.volume : 0,
        audioContext?.currentTime ?? 0,
        0.015,
      );
    }
  };

  const drawAudioMeters = () => {
    for (const track of tracks.audio) {
      const canvas = elements.trackRows.querySelector(`[data-track-id="${CSS.escape(track.id)}"] .track-meter`);
      if (!canvas) continue;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      const analysers = [...audioPlayers.values()].filter((player) => player.trackId === track.id).map((player) => player.analyser);
      let peak = 0;
      for (const analyser of analysers) {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      context.fillStyle = track.muted ? "#66616a" : "#b6f36b";
      context.fillRect(0, 0, Math.min(canvas.width, peak * canvas.width * 3), canvas.height);
    }
    if (sequencePlaying) audioMeterFrame = requestAnimationFrame(drawAudioMeters);
  };

  const renderTrackInspector = (track) => {
    if (!track) return;
    const audioTrack = track.kind === "audio";
    elements.inspector.innerHTML = `<div class="detail-title"><span class="detail-icon${audioTrack ? " audio" : ""}">${audioTrack ? "♫" : "▤"}</span><div><strong>${track.id} · ${audioTrack ? "Audio" : "Video"} track</strong><small>TRACK MIXER</small></div></div>${audioTrack ? `<div class="detail-group"><h3>Mix</h3><label class="detail-row" for="inspector-track-gain"><span>Track gain</span><input id="inspector-track-gain" type="range" min="0" max="1" step="0.01" value="${track.volume}"></label><label class="detail-row" for="inspector-track-mute"><span>Mute</span><input id="inspector-track-mute" type="checkbox" ${track.muted ? "checked" : ""}></label><label class="detail-row" for="inspector-track-solo"><span>Solo</span><input id="inspector-track-solo" type="checkbox" ${track.solo ? "checked" : ""}></label><div class="detail-row"><span>Clips</span><span>${timeline.audio.filter((clip) => clip.trackId === track.id).length}</span></div></div>` : `<div class="detail-group"><h3>Track</h3><div class="detail-row"><span>Clips</span><span>${timeline.video.filter((clip) => clip.trackId === track.id).length}</span></div><p class="track-inspector-hint">Video is previewed in sequence order; audio tracks are mixed together.</p></div>`}`;
    const gain = document.querySelector("#inspector-track-gain");
    gain?.addEventListener("pointerdown", (event) => {
      const slider = event.currentTarget;
      if (!slider.dataset.historyRecorded) {
        recordUndo();
        slider.dataset.historyRecorded = "true";
      }
    });
    gain?.addEventListener("input", () => {
      track.volume = Number(gain.value);
      const rowGain = elements.trackRows.querySelector(`[data-track-id="${CSS.escape(track.id)}"] .track-gain`);
      if (rowGain) rowGain.value = gain.value;
      refreshAudioGains();
      scheduleAutosave();
    });
    for (const [selector, property] of [["#inspector-track-mute", "muted"], ["#inspector-track-solo", "solo"]]) {
      document.querySelector(selector)?.addEventListener("change", (event) => {
        recordUndo();
        track[property] = event.target.checked;
        renderTimeline();
        renderTrackInspector(track);
        refreshAudioGains();
        scheduleAutosave();
      });
    }
  };

  const showToast = (message) => {
    document.querySelector(".toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 3200);
  };

  const renderMedia = () => {
    const query = elements.searchInput.value.trim().toLowerCase();
    const shown = media.filter((item) => {
      const matchesType = activeFilter === "all" || item.kind === activeFilter;
      return matchesType && item.name.toLowerCase().includes(query);
    });

    elements.mediaList.replaceChildren();
    elements.emptyLibrary.hidden = media.length > 0;
    elements.allCount.textContent = String(media.length);
    const missingCount = media.filter((item) => !item.file).length;
    elements.librarySummary.textContent = missingCount > 0
      ? `${missingCount} source${missingCount === 1 ? "" : "s"} need relinking`
      : `${media.length} ${media.length === 1 ? "item" : "items"} · saved in this browser`;

    if (media.length === 0) {
      elements.mediaList.append(elements.emptyLibrary);
      return;
    }

    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "no-results";
      empty.textContent = "No matching media.";
      elements.mediaList.append(empty);
      return;
    }

    for (const item of shown) {
      const card = document.createElement("article");
      card.className = `media-card${selectedMediaId === item.id ? " selected" : ""}${item.file ? "" : " missing"}`;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", item.file ? `Preview ${item.name}` : `Relink missing media ${item.name}`);
      card.draggable = Boolean(item.file);

      const thumb = document.createElement("div");
      thumb.className = `media-thumb${item.kind === "audio" ? " audio" : ""}`;
      thumb.textContent = item.kind === "audio" ? "♫" : "▶";
      if (item.thumbnail) {
        thumb.textContent = "";
        thumb.style.backgroundImage = `url("${item.thumbnail}")`;
        thumb.style.backgroundSize = "cover";
        thumb.style.backgroundPosition = "center";
      }

      const meta = document.createElement("div");
      meta.className = "media-meta";
      const name = document.createElement("span");
      name.className = "media-name";
      name.textContent = item.name;
      const info = document.createElement("span");
      info.className = "media-info";
      info.textContent = item.file
        ? `${item.kind.toUpperCase()} · ${item.duration ? formatTime(item.duration) : "READING"} · ${formatSize(item.size)}`
        : `MISSING · ${item.kind.toUpperCase()} · ${formatSize(item.size)}`;
      meta.append(name, info);

      const add = document.createElement("button");
      add.className = "media-add";
      add.type = "button";
      add.textContent = item.file ? "+" : "↗";
      add.title = item.file ? "Add to timeline" : "Choose source file to relink";
      add.setAttribute("aria-label", item.file ? `Add ${item.name} to timeline` : `Relink ${item.name}`);
      add.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!item.file) {
          selectMedia(item.id);
          elements.fileInput.click();
          return;
        }
        selectMedia(item.id);
        addToTimeline(item.id);
      });

      card.append(thumb, meta, add);
      card.addEventListener("click", () => selectMedia(item.id));
      card.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("application/x-framewave-media", item.id);
        event.dataTransfer.effectAllowed = "copy";
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectMedia(item.id);
        }
      });
      elements.mediaList.append(card);
    }
  };

  const renderInspector = (item, clip = null) => {
    if (!item) {
      elements.inspector.innerHTML = '<div class="inspector-empty"><span aria-hidden="true">⌁</span><strong>Nothing selected</strong><p>Select media or a timeline clip to view its details.</p></div>';
      return;
    }

    const icon = item.kind === "audio" ? "♫" : "▶";
    const kindClass = item.kind === "audio" ? " audio" : "";
    const duration = Number.isFinite(item.duration) && item.duration > 0 ? formatTime(item.duration) : "Reading metadata";
    const timelineControls = clip
      ? `<div class="detail-group"><h3>Timeline</h3><label class="detail-row" for="clip-position"><span>Position (sec)</span><input id="clip-position" type="number" min="0" step="0.05" value="${clip.start.toFixed(2)}"></label><label class="detail-row" for="clip-in"><span>Source in (sec)</span><input id="clip-in" type="number" min="0" step="0.05" value="${clip.sourceStart.toFixed(2)}"></label><label class="detail-row" for="clip-out"><span>Source out (sec)</span><input id="clip-out" type="number" min="0.05" step="0.05" value="${clip.sourceEnd.toFixed(2)}"></label><div class="detail-row"><span>Track</span><span>${clip.trackId}</span></div><button class="button button-outline" id="remove-clip" type="button">Remove from timeline</button></div>${clip.kind === "audio" ? `<div class="detail-group"><h3>Audio</h3><label class="detail-row" for="clip-volume"><span>Clip gain</span><input id="clip-volume" type="range" min="0" max="1" step="0.01" value="${clip.volume}"></label><label class="detail-row" for="clip-muted"><span>Mute clip</span><input id="clip-muted" type="checkbox" ${clip.muted ? "checked" : ""}></label><label class="detail-row" for="clip-fade-in"><span>Fade in (sec)</span><input id="clip-fade-in" type="number" min="0" max="${clipDuration(clip).toFixed(2)}" step="0.05" value="${clip.fadeIn}"></label><label class="detail-row" for="clip-fade-out"><span>Fade out (sec)</span><input id="clip-fade-out" type="number" min="0" max="${clipDuration(clip).toFixed(2)}" step="0.05" value="${clip.fadeOut}"></label></div>` : ""}`
      : `<div class="detail-group"><h3>Source</h3><div class="detail-row"><span>Duration</span><span>${duration}</span></div><div class="detail-row"><span>File size</span><span>${formatSize(item.size)}</span></div><div class="detail-row"><span>Format</span><span>${escapeHtml(item.type || "Unknown")}</span></div></div>`;
    const audioEffects = clip?.kind === "audio"
      ? `<div class="detail-group"><h3>Noise reduction</h3><label class="detail-row" for="clip-noise-reduction"><span>Strength · ${clip.noiseReduction ?? 0}</span><input id="clip-noise-reduction" type="range" min="0" max="30" step="1" value="${clip.noiseReduction ?? 0}" aria-label="Noise reduction strength"></label><p class="track-inspector-hint">0 disables it; higher values reduce steady background noise but may affect voice quality. Applied on export; live playback is unchanged.</p></div>`
      : "";
    const autoTune = clip?.kind === "audio" ? { ...defaultAutoTune(), ...clip.autoTune } : null;
    const autoTuneControls = autoTune
      ? `<div class="detail-group"><h3>Auto-Tune</h3><label class="detail-row" for="clip-auto-tune"><span>Enable live pitch correction</span><input id="clip-auto-tune" type="checkbox" ${autoTune.enabled ? "checked" : ""}></label><label class="detail-row" for="clip-auto-tune-key"><span>Key</span><select id="clip-auto-tune-key" aria-label="Auto-Tune key">${autoTuneKeys.map((key, index) => `<option value="${index}" ${autoTune.key === index ? "selected" : ""}>${key}</option>`).join("")}</select></label><label class="detail-row" for="clip-auto-tune-scale"><span>Scale</span><select id="clip-auto-tune-scale" aria-label="Auto-Tune scale"><option value="major" ${autoTune.scale === "major" ? "selected" : ""}>Major</option><option value="minor" ${autoTune.scale === "minor" ? "selected" : ""}>Minor</option><option value="chromatic" ${autoTune.scale === "chromatic" ? "selected" : ""}>Chromatic</option></select></label><label class="detail-row" for="clip-auto-tune-amount"><span>Amount · <span id="clip-auto-tune-amount-value">${autoTune.amount}%</span></span><input id="clip-auto-tune-amount" type="range" min="0" max="100" step="1" value="${autoTune.amount}" aria-label="Auto-Tune amount"></label><p class="track-inspector-hint">Corrects detected single-note audio to the selected scale during playback and export. Exports use FFmpeg pitch shifting, so they may sound different from live preview. Best with solo vocals. Live preview requires localhost or trusted HTTPS.</p></div>`
      : "";
    const titleStyle = clip?.kind === "video" ? { ...defaultTitleStyle(), ...clip.titleStyle } : null;
    const titlePositions = [
      ["top-left", "Top left"], ["top-center", "Top center"], ["top-right", "Top right"],
      ["center-left", "Center left"], ["center", "Center"], ["center-right", "Center right"],
      ["bottom-left", "Bottom left"], ["bottom-center", "Bottom center"], ["bottom-right", "Bottom right"],
    ];
    const transitionIn = clip?.transitionIn ?? (clip?.fadeIn > 0 ? "fade" : "cut");
    const transitionOut = clip?.transitionOut ?? (clip?.fadeOut > 0 ? "fade" : "cut");
    const videoControls = clip?.kind === "video"
      ? `<div class="detail-group"><h3>Titles</h3><label class="detail-row detail-row-stacked" for="clip-title"><span>Text</span><input id="clip-title" type="text" maxlength="256" value="${escapeAttribute(clip.title ?? "")}" placeholder="Enter title text"></label><label class="detail-row" for="clip-title-size"><span>Size · <span id="clip-title-size-value">${titleStyle.size}%</span></span><input id="clip-title-size" type="range" min="2" max="18" step="0.5" value="${titleStyle.size}"></label><label class="detail-row" for="clip-title-family"><span>Typeface</span><select id="clip-title-family"><option value="sans-serif" ${titleStyle.family === "sans-serif" ? "selected" : ""}>Sans serif</option><option value="serif" ${titleStyle.family === "serif" ? "selected" : ""}>Serif</option><option value="monospace" ${titleStyle.family === "monospace" ? "selected" : ""}>Monospace</option></select></label><label class="detail-row" for="clip-title-weight"><span>Weight</span><select id="clip-title-weight"><option value="400" ${titleStyle.weight === 400 ? "selected" : ""}>Regular</option><option value="600" ${titleStyle.weight === 600 ? "selected" : ""}>Semibold</option><option value="700" ${titleStyle.weight === 700 ? "selected" : ""}>Bold</option></select></label><label class="detail-row" for="clip-title-color"><span>Color</span><input id="clip-title-color" type="color" value="${titleStyle.color}"></label><label class="detail-row" for="clip-title-position"><span>Position</span><select id="clip-title-position">${titlePositions.map(([value, label]) => `<option value="${value}" ${titleStyle.position === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="detail-row" for="clip-title-background"><span>Background</span><select id="clip-title-background"><option value="none" ${titleStyle.background === "none" ? "selected" : ""}>None</option><option value="box" ${titleStyle.background === "box" ? "selected" : ""}>Text box</option></select></label></div><div class="detail-group"><h3>Transitions</h3><label class="detail-row" for="clip-transition-in"><span>In</span><select id="clip-transition-in"><option value="cut" ${transitionIn === "cut" ? "selected" : ""}>Cut</option><option value="fade" ${transitionIn === "fade" ? "selected" : ""}>Fade from black</option></select></label><label class="detail-row" for="clip-fade-in"><span>In duration (sec)</span><input id="clip-fade-in" type="number" min="0" max="${clipDuration(clip).toFixed(2)}" step="0.05" value="${clip.fadeIn}"></label><label class="detail-row" for="clip-transition-out"><span>Out</span><select id="clip-transition-out"><option value="cut" ${transitionOut === "cut" ? "selected" : ""}>Cut</option><option value="fade" ${transitionOut === "fade" ? "selected" : ""}>Fade to black</option></select></label><label class="detail-row" for="clip-fade-out"><span>Out duration (sec)</span><input id="clip-fade-out" type="number" min="0" max="${clipDuration(clip).toFixed(2)}" step="0.05" value="${clip.fadeOut}"></label></div><div class="detail-group"><h3>Color adjustments</h3><label class="detail-row" for="clip-brightness"><span>Brightness</span><input id="clip-brightness" type="range" min="-1" max="1" step="0.01" value="${clip.color.brightness}"></label><label class="detail-row" for="clip-contrast"><span>Contrast</span><input id="clip-contrast" type="range" min="0" max="2" step="0.01" value="${clip.color.contrast}"></label><label class="detail-row" for="clip-saturation"><span>Saturation</span><input id="clip-saturation" type="range" min="0" max="2" step="0.01" value="${clip.color.saturation}"></label><label class="detail-row" for="clip-hue"><span>Hue (deg)</span><input id="clip-hue" type="range" min="0" max="359" step="1" value="${clip.color.hue}"></label></div>`
      : "";
    const splitFiles = separationResult?.mediaId === item.id
      ? `<div class="separation-downloads"><a class="button button-outline" href="${separationResult.videoUrl}" download="${escapeAttribute(separationResult.videoName)}">Download silent video</a><a class="button button-outline" href="${separationResult.audioUrl}" download="${escapeAttribute(separationResult.audioName)}">Download extracted audio</a></div>`
      : "";
    const sourceTools = item.kind === "video" && item.file
      ? `<div class="detail-group"><h3>Source tools</h3><p class="track-inspector-hint">Create a silent MP4 and an audio file from the full source. The first embedded audio track is extracted.</p><button class="button button-outline" id="separate-source-media" type="button">Separate audio &amp; video</button>${splitFiles}</div>`
      : "";

    const missingSource = item.file ? "" : '<div class="detail-group missing-notice"><p>This source is not on this device. Import the original media to relink it.</p><button class="button button-outline" id="relink-source" type="button">Choose source file</button></div>';
    elements.inspector.innerHTML = `<div class="detail-title"><span class="detail-icon${kindClass}">${icon}</span><div><strong title="${escapeAttribute(item.name)}">${escapeHtml(item.name)}</strong><small>${item.kind.toUpperCase()} SOURCE</small></div></div>${missingSource}${sourceTools}${timelineControls}${audioEffects}${autoTuneControls}${videoControls}`;

    document.querySelector("#relink-source")?.addEventListener("click", () => elements.fileInput.click());
    document.querySelector("#separate-source-media")?.addEventListener("click", (event) => {
      separateSourceMedia(item, event.currentTarget).catch((error) => {
        console.error(`Could not separate media from ${item.name}:`, error);
        showToast(`Could not separate this video: ${error.message}`);
      });
    });
    const noiseReduction = document.querySelector("#clip-noise-reduction");
    noiseReduction?.addEventListener("pointerdown", (event) => {
      if (!event.currentTarget.dataset.historyRecorded) {
        recordUndo();
        event.currentTarget.dataset.historyRecorded = "true";
      }
    });
    noiseReduction?.addEventListener("input", () => {
      clip.noiseReduction = Number(noiseReduction.value);
      noiseReduction.closest("label").querySelector("span").textContent = `Strength · ${clip.noiseReduction}`;
      scheduleAutosave();
    });
    const autoTuneToggle = document.querySelector("#clip-auto-tune");
    autoTuneToggle?.addEventListener("change", () => {
      if (autoTuneToggle.checked && item.size > 80 * 1024 * 1024) {
        autoTuneToggle.checked = false;
        showToast("Auto-Tune preview is limited to audio files up to 80 MB.");
        return;
      }
      recordUndo();
      clip.autoTune = { ...defaultAutoTune(), ...clip.autoTune, enabled: autoTuneToggle.checked };
      scheduleAutosave();
      if (!clip.autoTune.enabled) {
        if (sequencePlaying) scheduleAudioSources().catch((error) => showToast(`Could not update audio playback: ${error.message}`));
        return;
      }
      if (!item.file) {
        showToast("Relink this audio source before using Auto-Tune.");
        return;
      }
      showToast("Analyzing audio for Auto-Tune...");
      ensureWaveform(item)
        .then(() => ensurePitchCurve(item))
        .then(() => {
          showToast("Auto-Tune is ready for timeline playback.");
          if (sequencePlaying) return scheduleAudioSources();
        })
        .catch((error) => {
          console.error(`Could not prepare Auto-Tune for ${item.name}:`, error);
          showToast(`Auto-Tune could not analyze this audio: ${error.message}`);
        });
    });
    for (const [selector, property] of [
      ["#clip-auto-tune-key", "key"],
      ["#clip-auto-tune-scale", "scale"],
    ]) {
      document.querySelector(selector)?.addEventListener("change", (event) => {
        recordUndo();
        clip.autoTune = { ...defaultAutoTune(), ...clip.autoTune, [property]: property === "key" ? Number(event.currentTarget.value) : event.currentTarget.value };
        scheduleAutosave();
        if (sequencePlaying) scheduleAudioSources().catch((error) => showToast(`Could not update Auto-Tune playback: ${error.message}`));
      });
    }
    const autoTuneAmount = document.querySelector("#clip-auto-tune-amount");
    autoTuneAmount?.addEventListener("pointerdown", (event) => {
      if (!event.currentTarget.dataset.historyRecorded) {
        recordUndo();
        event.currentTarget.dataset.historyRecorded = "true";
      }
    });
    autoTuneAmount?.addEventListener("pointerup", () => { autoTuneAmount.dataset.historyRecorded = ""; });
    autoTuneAmount?.addEventListener("input", () => {
      clip.autoTune = { ...defaultAutoTune(), ...clip.autoTune, amount: Number(autoTuneAmount.value) };
      document.querySelector("#clip-auto-tune-amount-value").textContent = `${clip.autoTune.amount}%`;
      scheduleAutosave();
    });
    autoTuneAmount?.addEventListener("change", () => {
      if (sequencePlaying) scheduleAudioSources().catch((error) => showToast(`Could not update Auto-Tune playback: ${error.message}`));
    });
    const titleInput = document.querySelector("#clip-title");
    titleInput?.addEventListener("input", () => {
      if (!titleInput.dataset.historyRecorded) {
        recordUndo();
        titleInput.dataset.historyRecorded = "true";
      }
      clip.title = titleInput.value;
      applyVideoClipStyle(clip);
      scheduleAutosave();
    });
    titleInput?.addEventListener("change", () => { titleInput.dataset.historyRecorded = ""; });
    const updateTitleStyle = (property, value) => {
      clip.titleStyle = { ...defaultTitleStyle(), ...clip.titleStyle, [property]: value };
      applyVideoClipStyle(clip);
      scheduleAutosave();
    };
    const titleSize = document.querySelector("#clip-title-size");
    titleSize?.addEventListener("pointerdown", () => {
      if (!titleSize.dataset.historyRecorded) {
        recordUndo();
        titleSize.dataset.historyRecorded = "true";
      }
    });
    titleSize?.addEventListener("input", () => {
      const value = Number(titleSize.value);
      updateTitleStyle("size", value);
      document.querySelector("#clip-title-size-value").textContent = `${value}%`;
    });
    titleSize?.addEventListener("change", () => { titleSize.dataset.historyRecorded = ""; });
    for (const [selector, property, parseValue] of [
      ["#clip-title-family", "family", (value) => value],
      ["#clip-title-weight", "weight", Number],
      ["#clip-title-color", "color", (value) => value],
      ["#clip-title-position", "position", (value) => value],
      ["#clip-title-background", "background", (value) => value],
    ]) {
      document.querySelector(selector)?.addEventListener("change", (event) => {
        recordUndo();
        updateTitleStyle(property, parseValue(event.currentTarget.value));
      });
    }
    for (const [selector, property, durationProperty] of [
      ["#clip-transition-in", "transitionIn", "fadeIn"],
      ["#clip-transition-out", "transitionOut", "fadeOut"],
    ]) {
      document.querySelector(selector)?.addEventListener("change", (event) => {
        recordUndo();
        clip[property] = event.currentTarget.value;
        if (clip[property] === "fade" && clip[durationProperty] === 0) {
          clip[durationProperty] = Math.min(0.5, clipDuration(clip) / 2);
        }
        applyVideoClipStyle(clip);
        syncVideoAtTime(playheadTime);
        renderInspector(item, clip);
        scheduleAutosave();
      });
    }
    for (const [selector, property] of [
      ["#clip-brightness", "brightness"],
      ["#clip-contrast", "contrast"],
      ["#clip-saturation", "saturation"],
      ["#clip-hue", "hue"],
    ]) {
      const input = document.querySelector(selector);
      input?.addEventListener("pointerdown", (event) => {
        if (!event.currentTarget.dataset.historyRecorded) {
          recordUndo();
          event.currentTarget.dataset.historyRecorded = "true";
        }
      });
      input?.addEventListener("input", () => {
        clip.color[property] = Number(input.value);
        applyVideoClipStyle(clip);
        scheduleAutosave();
      });
    }
    const clipVolume = document.querySelector("#clip-volume");
    clipVolume?.addEventListener("pointerdown", (event) => {
      const slider = event.currentTarget;
      if (!slider.dataset.historyRecorded) {
        recordUndo();
        slider.dataset.historyRecorded = "true";
      }
    });
    clipVolume?.addEventListener("input", (event) => {
      clip.volume = Number(event.target.value);
      if (selectedClipId === clip.id && activeSource) {
        sourceElement().volume = clip.volume * Number(elements.volumeSlider.value);
      }
      refreshAudioGains();
      if (sequencePlaying) drawAudioMeters();
      scheduleAutosave();
    });
    document.querySelector("#clip-muted")?.addEventListener("change", (event) => {
      recordUndo();
      clip.muted = event.target.checked;
      if (selectedClipId === clip.id && activeSource) {
        sourceElement().muted = clip.muted;
        updateMuteButton(clip.muted);
      }
      refreshAudioGains();
      scheduleAutosave();
    });
    for (const [selector, property] of [["#clip-position", "start"], ["#clip-in", "sourceStart"], ["#clip-out", "sourceEnd"]]) {
      const input = document.querySelector(selector);
      input?.addEventListener("change", () => {
        const value = Number(input.value);
        const minimum = property === "sourceEnd" ? clip.sourceStart + 0.05 : 0;
        const maximum = property === "start" ? Number.POSITIVE_INFINITY : item.duration;
        if (!Number.isFinite(value) || value < minimum || value > maximum ||
          (property === "sourceStart" && value >= clip.sourceEnd - 0.05)) {
          input.value = String(clip[property]);
          showToast("Enter valid clip times within the source duration.");
          return;
        }
        recordUndo();
        clip[property] = property === "start" ? Math.max(0, value) : value;
        if (clip.fadeIn + clip.fadeOut > clipDuration(clip)) clip.fadeOut = Math.max(0, clipDuration(clip) - clip.fadeIn);
        renderTimeline();
        renderInspector(item, clip);
        scheduleAudioSources();
        scheduleAutosave();
      });
    }
    for (const [selector, property] of [["#clip-fade-in", "fadeIn"], ["#clip-fade-out", "fadeOut"]]) {
      const input = document.querySelector(selector);
      input?.addEventListener("change", () => {
        const value = Number(input.value);
        const otherFade = clip[property === "fadeIn" ? "fadeOut" : "fadeIn"];
        if (!Number.isFinite(value) || value < 0 || value + otherFade > clipDuration(clip)) {
          input.value = String(clip[property]);
          showToast("Fade lengths must fit within the clip duration.");
          return;
        }
        recordUndo();
        clip[property] = value;
        if (clip.kind === "video") {
          applyVideoClipStyle(clip);
          syncVideoAtTime(playheadTime);
        }
        scheduleAudioSources();
        scheduleAutosave();
      });
    }
    document.querySelector("#remove-clip")?.addEventListener("click", () => removeClip(clip.id));
  };

  const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

  const escapeAttribute = escapeHtml;

  const selectMedia = (id) => {
    const item = media.find((entry) => entry.id === id);
    if (!item) return;
    if (sequencePlaying) pauseSequence();
    activeVideoClipId = null;
    selectedMediaId = id;
    selectedClipId = null;
    selectedClipIds = new Set();
    activeSource = item.file ? item : null;

    clearPreviewLayers();
    elements.videoPreview.pause();
    applyVideoClipStyle(null);
    elements.audioPreview.pause();
    elements.videoPreview.hidden = !item.file || item.kind !== "video";
    elements.audioArtwork.hidden = !item.file || item.kind !== "audio";
    elements.viewerEmpty.hidden = Boolean(item.file);
    elements.audioPreview.hidden = true;
    elements.viewerSource.textContent = item.file ? item.name : `${item.name} · missing source`;
    elements.audioSourceName.textContent = item.name;

    if (!item.file) {
      elements.viewerEmpty.querySelector("p").textContent = "Media file needs relinking";
      elements.viewerEmpty.querySelector("small").textContent = "Choose the original file to preview";
      elements.videoPreview.removeAttribute("src");
      elements.audioPreview.removeAttribute("src");
    } else if (item.kind === "video") {
      elements.viewerEmpty.querySelector("p").textContent = "Choose a clip from your library";
      elements.viewerEmpty.querySelector("small").textContent = "Your source preview will appear here";
      elements.videoPreview.src = item.url;
      elements.videoPreview.volume = Number(elements.volumeSlider.value);
    } else {
      elements.viewerEmpty.querySelector("p").textContent = "Choose a clip from your library";
      elements.viewerEmpty.querySelector("small").textContent = "Your source preview will appear here";
      elements.audioPreview.src = item.url;
      elements.audioPreview.volume = Number(elements.volumeSlider.value);
    }
    if (activeSource) sourceElement().muted = false;
    updateMuteButton(false);

    elements.playButton.textContent = "▶";
    elements.playButton.setAttribute("aria-label", "Play");
    elements.seekSlider.value = "0";
    elements.currentTime.textContent = "00:00";
    elements.durationTime.textContent = formatTime(item.duration);
    document.querySelector("#add-selected").disabled = !item.file;
    renderInspector(item);
    renderMedia();
    updatePlayhead();
    updateSelectionButtons();
    scheduleAutosave();
  };

  const probeDuration = (item) => {
    if (!item.file) return;
    const probe = document.createElement(item.kind);
    probe.preload = "metadata";
    if (item.kind === "video") {
      const captureThumbnail = () => {
        if (!probe.videoWidth || !probe.videoHeight) return;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 160;
          canvas.height = 90;
          const context = canvas.getContext("2d");
          const scale = Math.min(canvas.width / probe.videoWidth, canvas.height / probe.videoHeight);
          const width = probe.videoWidth * scale;
          const height = probe.videoHeight * scale;
          context.fillStyle = "#111318";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(probe, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          item.thumbnail = canvas.toDataURL("image/jpeg", 0.72);
          renderMedia();
        } catch (error) {
          console.error(`Could not create a thumbnail for ${item.name}:`, error);
        }
      };
      probe.addEventListener("loadeddata", () => {
        const previewTime = Math.min(item.duration / 2, 1);
        if (previewTime > 0) {
          probe.addEventListener("seeked", captureThumbnail, { once: true });
          probe.currentTime = previewTime;
        } else captureThumbnail();
      }, { once: true });
    }
    probe.src = item.url;
    probe.addEventListener("loadedmetadata", () => {
      item.duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      renderMedia();
      if (selectedMediaId === item.id) {
        elements.durationTime.textContent = formatTime(item.duration);
        renderInspector(item);
      }
      scheduleAutosave();
    }, { once: true });
    probe.addEventListener("error", () => {
      showToast(`Could not read media metadata for ${item.name}.`);
    }, { once: true });
    ensureWaveform(item);
  };

  const addFiles = async (files) => {
    const supported = [...files].filter((file) => file.type.startsWith("audio/") || file.type.startsWith("video/"));
    if (supported.length === 0) {
      showToast("Choose a supported audio or video file.");
      return;
    }
    if (supported.length < files.length) showToast("Some files were skipped: only audio and video are supported.");

    recordUndo();
    const missingBeforeImport = media.some((item) => !item.file);
    const changedAssets = [];
    const relinked = [];
    for (const file of supported) {
      const kind = isVideo(file) ? "video" : "audio";
      const missing = media.find((item) =>
        !item.file && item.name === file.name && item.type === file.type &&
        item.size === file.size && item.kind === kind);
      if (missing) {
        pitchCurves.delete(missing.id);
        const cachedTune = autoTuneNodes.get(missing.id);
        if (cachedTune) {
          cachedTune.node.disconnect();
          autoTuneNodes.delete(missing.id);
        }
        missing.file = file;
        missing.url = URL.createObjectURL(file);
        missing.lastModified = file.lastModified;
        changedAssets.push(missing);
        relinked.push(missing);
        probeDuration(missing);
        continue;
      }

      const item = {
        id: createId("media"),
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        file,
        url: URL.createObjectURL(file),
        kind,
        duration: 0,
        storageReady: false,
      };
      media.push(item);
      changedAssets.push(item);
      probeDuration(item);
    }

    if (changedAssets.length > 0) {
      try {
        await writeAssetsToStorage(changedAssets);
        for (const item of changedAssets) item.storageReady = true;
      } catch (error) {
        handleStorageError(error);
        renderMedia();
        return;
      }
    }
    renderMedia();
    if (relinked.length > 0) {
      const unmatchedCount = supported.length - relinked.length;
      showToast(unmatchedCount > 0
        ? `Relinked ${relinked.length} source${relinked.length === 1 ? "" : "s"}. ${unmatchedCount} imported file${unmatchedCount === 1 ? " did" : "s did"} not match missing sources.`
        : `Relinked ${relinked.length} missing source${relinked.length === 1 ? "" : "s"}.`);
      if (relinked.some((item) => item.id === selectedMediaId)) selectMedia(selectedMediaId);
    } else if (missingBeforeImport) {
      showToast("No missing source matched. Relinking requires the same filename, file type, and file size.");
    } else if (!selectedMediaId && media.length > 0) {
      selectMedia(media[0].id);
    }
    if (changedAssets.length > 0) scheduleAutosave();
  };

  const clipDuration = (clip) => clip.sourceEnd - clip.sourceStart;
  const sequenceDuration = () => Math.max(
    ...["video", "audio"].flatMap((kind) => timeline[kind].map((clip) => engine.clipEnd(clip))),
    0,
  );
  const pixelsPerSecond = () => 36 * timelineZoom / 100;
  const trackForClip = (clip) => tracks[clip.kind].find((track) => track.id === clip.trackId) ?? tracks[clip.kind][0];

  const renderWaveform = (item, canvas, clip) => {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    const peaks = waveformCache.get(item.id);
    if (!peaks?.length || !clip || item.duration <= 0) return;
    context.fillStyle = "#b99df0";
    const sourceStart = Math.floor(clip.sourceStart / item.duration * peaks.length);
    const sourceEnd = Math.min(peaks.length, Math.ceil(clip.sourceEnd / item.duration * peaks.length));
    const count = Math.max(1, sourceEnd - sourceStart);
    const width = canvas.width / count;
    for (let index = 0; index < count; index += 1) {
      const height = Math.max(1, peaks[sourceStart + index] * (canvas.height - 3));
      context.fillRect(index * width, (canvas.height - height) / 2, Math.max(1, width - 1), height);
    }
  };

  const handleClipPointerDown = (event, clip, lane, block) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      toggleClipSelection(clip);
      return;
    }
    const handle = event.target.closest("[data-trim]")?.dataset.trim ?? "move";
    dragState = {
      clip,
      lane,
      block,
      handle,
      pointerX: event.clientX,
      initialStart: clip.start,
      initialSourceStart: clip.sourceStart,
      initialSourceEnd: clip.sourceEnd,
      linkedClips: linkedClipsFor(clip),
      moved: false,
    };
    if (selectedClipId !== clip.id || !selectedClipIds.has(clip.id)) {
      selectClip(clip.id, false, selectedClipIds.has(clip.id) && selectedClipIds.size > 1);
    }
    dragState.block = elements.trackRows.querySelector(`[data-clip-id="${CSS.escape(clip.id)}"]`);
    dragState.block?.classList.add("dragging");
  };

  const handleClipPointerMove = (event) => {
    if (!dragState) return;
    const delta = (event.clientX - dragState.pointerX) / pixelsPerSecond();
    if (Math.abs(delta) < 0.03 && !dragState.moved) return;
    dragState.moved = true;
    const { clip, handle, lane, block, linkedClips } = dragState;
    const peers = timeline[clip.kind].filter((item) => item.trackId === clip.trackId);
    const mediaItem = media.find((item) => item.id === clip.mediaId);
    let preview;
    if (handle === "move") {
      preview = engine.moveClip(clip, dragState.initialStart + delta, peers, document.querySelector("#snap-toggle").checked);
    } else {
      const proposedTime = handle === "left"
        ? dragState.initialStart + delta
        : dragState.initialStart + dragState.initialSourceEnd - dragState.initialSourceStart + delta;
      preview = engine.trimClip(
        clip,
        handle,
        proposedTime,
        mediaItem.duration,
        document.querySelector("#snap-toggle").checked,
        peers,
      );
    }
    dragState.preview = preview;
    block.style.left = `${7 + preview.start * pixelsPerSecond()}px`;
    block.style.width = `${Math.max(24, clipDuration(preview) * pixelsPerSecond())}px`;
    block.querySelector(".clip-duration").textContent = formatTime(clipDuration(preview));
    for (const linked of linkedClips) {
      const linkedBlock = elements.trackRows.querySelector(`[data-clip-id="${CSS.escape(linked.id)}"]`);
      if (!linkedBlock) continue;
      const linkedMedia = media.find((item) => item.id === linked.mediaId);
      const linkedPreview = editing.linkedClipPreview(clip, preview, linked, handle, linkedMedia?.duration);
      linkedBlock.style.left = `${7 + linkedPreview.start * pixelsPerSecond()}px`;
      linkedBlock.style.width = `${Math.max(24, clipDuration(linkedPreview) * pixelsPerSecond())}px`;
      linkedBlock.querySelector(".clip-duration").textContent = formatTime(clipDuration(linkedPreview));
    }
    if (lane) lane.classList.add("drop-ready");
  };

  const finishClipPointer = () => {
    if (!dragState) return;
    const state = dragState;
    dragState = null;
    document.querySelectorAll(".track-lane.drop-ready").forEach((lane) => lane.classList.remove("drop-ready"));
    state.block.classList.remove("dragging");
    if (!state.moved || !state.preview) {
      if (selectedClipId !== state.clip.id) selectClip(state.clip.id);
      return;
    }

    const originalClip = { ...state.clip };
    const previousEnd = engine.clipEnd(state.clip);
    recordUndo();
    Object.assign(state.clip, state.preview);
    const fitFades = (clip) => {
      clip.fadeIn = Math.min(clip.fadeIn, clipDuration(clip));
      clip.fadeOut = Math.min(clip.fadeOut, Math.max(0, clipDuration(clip) - clip.fadeIn));
    };
    fitFades(state.clip);
    for (const linked of state.linkedClips) {
      const linkedMedia = media.find((item) => item.id === linked.mediaId);
      Object.assign(
        linked,
        editing.linkedClipPreview(originalClip, state.preview, linked, state.handle, linkedMedia?.duration),
      );
      fitFades(linked);
    }
    if (state.handle === "right" && document.querySelector("#ripple-toggle").checked) {
      const ripple = clipDuration(state.clip) - (previousEnd - state.clip.start);
      for (const following of timeline[state.clip.kind]) {
        if (following.id !== state.clip.id && following.trackId === state.clip.trackId && following.start >= previousEnd - 0.001) {
          following.start = Math.max(state.clip.start + clipDuration(state.clip), following.start + ripple);
        }
      }
    }
    selectClip(state.clip.id, true, selectedClipIds.size > 1);
    scheduleAutosave();
  };

  const createTrackRow = (track, index) => {
    const row = document.createElement("div");
    row.className = `track-row ${track.kind}-track-row`;
    row.dataset.track = track.kind;
    row.dataset.trackId = track.id;

    const gutter = document.createElement("div");
    gutter.className = "track-gutter";
    const badge = document.createElement("strong");
    badge.draggable = true;
    badge.title = `Drag to reorder ${track.id} track`;
    if (track.kind === "audio") badge.classList.add("audio-track");
    badge.textContent = track.id;
    const label = document.createElement("span");
    label.textContent = `${track.kind === "video" ? "Video" : "Audio"} ${index + 1}`;
    gutter.append(badge, label);

    if (track.kind === "audio") {
      const mute = document.createElement("button");
      mute.type = "button";
      mute.className = `track-toggle${track.muted ? " active" : ""}`;
      mute.textContent = "M";
      mute.title = "Mute track";
      mute.setAttribute("aria-label", `${track.muted ? "Unmute" : "Mute"} track ${track.id}`);
      mute.addEventListener("click", () => {
        recordUndo();
        track.muted = !track.muted;
        renderTimeline();
        refreshAudioGains();
        if (sequencePlaying) drawAudioMeters();
        scheduleAutosave();
      });
      const solo = document.createElement("button");
      solo.type = "button";
      solo.className = `track-toggle solo-toggle${track.solo ? " active" : ""}`;
      solo.textContent = "S";
      solo.title = "Solo track";
      solo.setAttribute("aria-label", `${track.solo ? "Unsolo" : "Solo"} track ${track.id}`);
      solo.addEventListener("click", () => {
        recordUndo();
        track.solo = !track.solo;
        renderTimeline();
        refreshAudioGains();
        scheduleAutosave();
      });
      const gain = document.createElement("input");
      gain.type = "range";
      gain.min = "0";
      gain.max = "1";
      gain.step = "0.01";
      gain.value = String(track.volume);
      gain.className = "track-gain";
      gain.title = `${track.id} gain`;
      gain.setAttribute("aria-label", `${track.id} track gain`);
      gain.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        if (!gain.dataset.historyRecorded) {
          recordUndo();
          gain.dataset.historyRecorded = "true";
        }
      });
      gain.addEventListener("pointerup", () => { gain.dataset.historyRecorded = ""; });
      gain.addEventListener("input", () => {
        track.volume = Number(gain.value);
        refreshAudioGains();
        scheduleAutosave();
      });
      const meter = document.createElement("canvas");
      meter.className = "track-meter";
      meter.width = 50;
      meter.height = 8;
      meter.setAttribute("aria-label", `${track.id} audio level meter`);
      gutter.append(mute, solo, gain, meter);
    }

    if (tracks[track.kind].length > 1) {
      const removeTrack = document.createElement("button");
      removeTrack.type = "button";
      removeTrack.className = "remove-track";
      removeTrack.textContent = "×";
      removeTrack.title = `Remove empty track ${track.id}`;
      removeTrack.addEventListener("click", () => {
        if (timeline[track.kind].some((clip) => clip.trackId === track.id)) {
          showToast("Move or remove this track's clips before deleting the track.");
          return;
        }
        recordUndo();
        tracks[track.kind].splice(index, 1);
        renderTimeline();
        scheduleAutosave();
      });
      gutter.append(removeTrack);
    }

    gutter.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-framewave-track", track.id);
      event.dataTransfer.effectAllowed = "move";
    });
    gutter.addEventListener("click", (event) => {
      if (event.target.closest("button, input")) return;
      selectedTrackId = track.id;
      renderTrackInspector(track);
    });
    row.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes("application/x-framewave-track")) event.preventDefault();
    });
    row.addEventListener("drop", (event) => {
      const draggedTrack = event.dataTransfer.getData("application/x-framewave-track");
      if (!draggedTrack || draggedTrack === track.id) return;
      event.preventDefault();
      reorderTrack(track.kind, draggedTrack, track.id);
    });

    const lane = document.createElement("div");
    lane.className = `track-lane ${track.kind === "audio" ? "audio-lane" : ""}`;
    lane.dataset.trackId = track.id;
    lane.style.width = `${Math.max(420, Math.ceil(Math.max(12, sequenceDuration()) * pixelsPerSecond()))}px`;
    lane.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes("application/x-framewave-media")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        lane.classList.add("drop-ready");
      }
    });
    lane.addEventListener("dragleave", () => lane.classList.remove("drop-ready"));
    lane.addEventListener("drop", (event) => {
      lane.classList.remove("drop-ready");
      const mediaId = event.dataTransfer.getData("application/x-framewave-media");
      const item = media.find((entry) => entry.id === mediaId);
      if (!item || item.kind !== track.kind) return;
      event.preventDefault();
      const start = Math.max(0, (event.clientX - lane.getBoundingClientRect().left + elements.timelineCanvas.scrollLeft - 7) / pixelsPerSecond());
      addToTimeline(mediaId, track.id, start);
    });
    lane.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".timeline-clip")) {
        const rect = lane.getBoundingClientRect();
        setPlayhead(Math.max(0, (event.clientX - rect.left + elements.timelineCanvas.scrollLeft - 7) / pixelsPerSecond()));
      }
    });
    const clips = timeline[track.kind]
      .filter((clip) => clip.trackId === track.id)
      .sort((left, right) => left.start - right.start);
    if (clips.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "track-placeholder";
      placeholder.textContent = `Drop ${track.kind} clips here`;
      lane.append(placeholder);
    }

    for (const clip of clips) {
      const item = media.find((entry) => entry.id === clip.mediaId);
      if (!item) continue;
      const block = document.createElement("div");
      block.className = `timeline-clip${track.kind === "audio" ? " audio-clip" : ""}${selectedClipIds.has(clip.id) ? " selected" : ""}${clip.linkGroupId ? " linked" : ""}${item.file ? "" : " missing"}`;
      block.dataset.clipId = clip.id;
      block.style.left = `${7 + clip.start * pixelsPerSecond()}px`;
      block.style.width = `${Math.max(24, clipDuration(clip) * pixelsPerSecond())}px`;
      block.title = `${item.name}${item.file ? "" : " · missing source"} · ${formatTime(clipDuration(clip))}`;
      const leftHandle = document.createElement("span");
      leftHandle.className = "trim-handle left-trim";
      leftHandle.dataset.trim = "left";
      leftHandle.setAttribute("aria-label", "Trim clip start");
      const name = document.createElement("span");
      name.className = "clip-name";
      name.textContent = item.name;
      const time = document.createElement("span");
      time.className = "clip-duration";
      time.textContent = formatTime(clipDuration(clip));
      const rightHandle = document.createElement("span");
      rightHandle.className = "trim-handle right-trim";
      rightHandle.dataset.trim = "right";
      rightHandle.setAttribute("aria-label", "Trim clip end");
      block.append(leftHandle, name, time);
      if (track.kind === "audio") {
        const waveform = document.createElement("canvas");
        waveform.className = "clip-waveform";
        waveform.width = 256;
        waveform.height = 24;
        waveform.setAttribute("aria-hidden", "true");
        renderWaveform(item, waveform, clip);
        block.append(waveform);
      }
      block.append(rightHandle);
      block.addEventListener("pointerdown", (event) => handleClipPointerDown(event, clip, lane, block));
      block.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey) return;
        if (!event.target.closest(".trim-handle") && !dragState?.moved) selectClip(clip.id);
      });
      lane.append(block);
    }
    row.append(gutter, lane);
    return row;
  };

  const reorderTrack = (kind, draggedId, targetId) => {
    const list = tracks[kind];
    const from = list.findIndex((track) => track.id === draggedId);
    const to = list.findIndex((track) => track.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    recordUndo();
    const [track] = list.splice(from, 1);
    list.splice(to, 0, track);
    renderTimeline();
    scheduleAutosave();
  };

  const createTrack = (kind) => {
    if (tracks[kind].length >= 16) {
      showToast(`A project can have up to 16 ${kind} tracks.`);
      return;
    }
    recordUndo();
    const prefix = kind === "video" ? "V" : "A";
    const used = new Set(tracks[kind].map((track) => track.id));
    let number = tracks[kind].length + 1;
    while (used.has(`${prefix}${number}`)) number += 1;
    const track = { id: `${prefix}${number}`, kind, muted: false, solo: false, volume: 1 };
    tracks[kind].push(track);
    selectedTrackId = track.id;
    renderTimeline();
    renderTrackInspector(track);
    scheduleAutosave();
  };

  const renderTimeline = () => {
    const total = sequenceDuration();
    const duration = Math.max(12, Math.ceil(total / 12) * 12);
    const width = Math.max(420, duration * pixelsPerSecond());
    elements.timelineCanvas.style.setProperty("--timeline-grid-width", `${2 * pixelsPerSecond()}px`);
    elements.timelineRuler.replaceChildren();
    elements.timelineRuler.style.width = `${width}px`;
    for (let second = 0; second <= duration; second += 2) {
      const mark = document.createElement("span");
      mark.className = "ruler-mark";
      mark.style.width = `${2 * pixelsPerSecond()}px`;
      mark.textContent = formatTime(second);
      elements.timelineRuler.append(mark);
    }

    elements.trackRows.replaceChildren();
    const videoHeader = document.createElement("div");
    videoHeader.className = "track-kind-label";
    videoHeader.textContent = "VIDEO";
    elements.trackRows.append(videoHeader);
    tracks.video.forEach((track, index) => elements.trackRows.append(createTrackRow(track, index)));
    const audioHeader = document.createElement("div");
    audioHeader.className = "track-kind-label";
    audioHeader.textContent = "AUDIO MIXER";
    elements.trackRows.append(audioHeader);
    tracks.audio.forEach((track, index) => elements.trackRows.append(createTrackRow(track, index)));

    elements.timelineSummary.textContent = `${sequenceSettings.width}×${sequenceSettings.height} · ${sequenceSettings.frameRate} fps · ${total > 0
      ? `${timeline.video.length + timeline.audio.length} clips · ${formatTime(total)}`
      : "No clips"}`;
    document.querySelector("#zoom-level").textContent = `${timelineZoom}%`;
    document.querySelector("#zoom-out").disabled = timelineZoom <= 25;
    document.querySelector("#zoom-in").disabled = timelineZoom >= 400;
    updatePlayhead();
    updateSelectionButtons();
  };

  const addToTimeline = (mediaId, trackId = null, start = null) => {
    const item = media.find((entry) => entry.id === mediaId);
    if (!item) return;
    if (!item.file) {
      showToast("Relink this media source before adding it to the timeline.");
      return;
    }
    if (!Number.isFinite(item.duration) || item.duration <= 0) {
      showToast("This file has no readable duration and cannot be added yet.");
      return;
    }

    const targetTrack = trackId
      ? tracks[item.kind].find((track) => track.id === trackId)
      : tracks[item.kind][0];
    if (!targetTrack) {
      showToast("Select a valid track for this clip.");
      return;
    }
    recordUndo();
    const clip = {
      id: createId("clip"),
      mediaId,
      kind: item.kind,
      trackId: targetTrack.id,
      start: start === null ? engine.timelineEnd(timeline[item.kind].filter((entry) => entry.trackId === targetTrack.id)) : Math.max(0, start),
      sourceStart: 0,
      sourceEnd: item.duration,
      linkGroupId: null,
      volume: Number(elements.volumeSlider.value),
      noiseReduction: 0,
      autoTune: defaultAutoTune(),
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      color: defaultColor(),
      title: "",
      titleStyle: defaultTitleStyle(),
      transitionIn: "cut",
      transitionOut: "cut",
    };
    timeline[item.kind].push(clip);
    selectClip(clip.id);
    scheduleAutosave();
  };

  const selectClip = (clipId, render = true, keepSelection = false) => {
    const clip = [...timeline.video, ...timeline.audio].find((entry) => entry.id === clipId);
    if (!clip) return;
    const existingSelection = selectedClipIds;
    selectedClipId = clipId;
    selectMedia(clip.mediaId);
    selectedClipId = clipId;
    if (!keepSelection) selectedClipIds = new Set([clipId]);
    else {
      selectedClipIds = existingSelection;
      selectedClipIds.add(clipId);
    }
    const item = media.find((entry) => entry.id === clip.mediaId);
    activeSource = item?.file ? { ...item, clip } : null;
    selectedTrackId = clip.trackId;
    if (activeSource) {
      const element = sourceElement();
      element.volume = clip.volume * Number(elements.volumeSlider.value);
      element.muted = clip.muted;
    }
    applyVideoClipStyle(clip.kind === "video" ? clip : null);
    updateMuteButton(clip.muted);
    renderInspector(item, clip);
    if (render) {
      renderTimeline();
    } else {
      elements.trackRows.querySelectorAll(".timeline-clip").forEach((block) => {
        block.classList.toggle("selected", selectedClipIds.has(block.dataset.clipId));
      });
    }
    updateSelectionButtons();
    scheduleAutosave();
  };

  const linkedClipsFor = (clip) => clip.linkGroupId
    ? [...timeline.video, ...timeline.audio].filter((entry) => entry.linkGroupId === clip.linkGroupId && entry.id !== clip.id)
    : [];

  const updateSelectionButtons = () => {
    const splitButton = document.querySelector("#split-at-playhead");
    const linkButton = document.querySelector("#link-clips");
    const unlinkButton = document.querySelector("#unlink-clips");
    const selected = [...selectedClipIds]
      .map((id) => [...timeline.video, ...timeline.audio].find((clip) => clip.id === id))
      .filter(Boolean);
    const alignedPair = selected.length === 2 &&
      selected[0].kind !== selected[1].kind &&
      Math.abs(selected[0].start - selected[1].start) <= 0.05 &&
      Math.abs(clipDuration(selected[0]) - clipDuration(selected[1])) <= 0.05;
    splitButton.disabled = !selected.some((clip) =>
      playheadTime > clip.start + 0.05 && playheadTime < engine.clipEnd(clip) - 0.05);
    linkButton.disabled = !alignedPair || selected.some((clip) => clip.linkGroupId);
    unlinkButton.disabled = selected.length === 0 || selected.every((clip) => !clip.linkGroupId);
  };

  const linkSelectedClips = () => {
    const selected = [...selectedClipIds]
      .map((id) => [...timeline.video, ...timeline.audio].find((clip) => clip.id === id))
      .filter(Boolean);
    if (selected.length !== 2 || selected[0].kind === selected[1].kind ||
      Math.abs(selected[0].start - selected[1].start) > 0.05 ||
      Math.abs(clipDuration(selected[0]) - clipDuration(selected[1])) > 0.05 ||
      selected.some((clip) => clip.linkGroupId)) {
      showToast("Select one video clip and one audio clip with matching timeline start and duration.");
      return;
    }
    recordUndo();
    const linkGroupId = createId("link");
    selected.forEach((clip) => { clip.linkGroupId = linkGroupId; });
    renderTimeline();
    scheduleAutosave();
  };

  const unlinkSelectedClips = () => {
    const groupIds = new Set([...selectedClipIds]
      .map((id) => [...timeline.video, ...timeline.audio].find((clip) => clip.id === id)?.linkGroupId)
      .filter(Boolean));
    if (groupIds.size === 0) return;
    recordUndo();
    for (const clip of [...timeline.video, ...timeline.audio]) {
      if (groupIds.has(clip.linkGroupId)) clip.linkGroupId = null;
    }
    renderTimeline();
    scheduleAutosave();
  };

  const splitSelectedAtPlayhead = () => {
    const allClips = [...timeline.video, ...timeline.audio];
    const selected = allClips.filter((clip) => selectedClipIds.has(clip.id));
    const splitIds = new Set(selected.map((clip) => clip.id));
    for (const clip of selected) {
      for (const linked of linkedClipsFor(clip)) splitIds.add(linked.id);
    }
    const splitTargets = allClips.filter((clip) => splitIds.has(clip.id));
    const splitPairs = new Map();
    const processedLinks = new Set();
    for (const clip of splitTargets) {
      if (clip.linkGroupId && processedLinks.has(clip.linkGroupId)) continue;
      if (clip.linkGroupId) processedLinks.add(clip.linkGroupId);
      const linked = linkedClipsFor(clip);
      if (linked.length > 0 && !splitIds.has(linked[0].id)) continue;
      const leftRight = editing.splitClipAt(clip, playheadTime, createId("clip"));
      if (!leftRight) continue;
      if (linked.length > 0) {
        const linkedSplit = editing.splitClipAt(linked[0], playheadTime, createId("clip"));
        if (!linkedSplit) continue;
        const rightLinkGroupId = createId("link");
        leftRight[0].linkGroupId = clip.linkGroupId;
        linkedSplit[0].linkGroupId = clip.linkGroupId;
        leftRight[1].linkGroupId = rightLinkGroupId;
        linkedSplit[1].linkGroupId = rightLinkGroupId;
        splitPairs.set(clip.id, { original: clip, left: leftRight[0], right: leftRight[1] });
        splitPairs.set(linked[0].id, { original: linked[0], left: linkedSplit[0], right: linkedSplit[1] });
      } else {
        splitPairs.set(clip.id, { original: clip, left: leftRight[0], right: leftRight[1] });
      }
    }
    if (splitPairs.size === 0) {
      showToast("Move the playhead inside the selected clip before splitting.");
      return;
    }
    recordUndo();
    const rightIds = [];
    for (const { original, left, right } of splitPairs.values()) {
      Object.assign(original, left);
      timeline[original.kind].push(right);
      rightIds.push(right.id);
    }
    selectedClipIds = new Set(rightIds);
    selectedClipId = rightIds[0];
    renderTimeline();
    if (selectedClipId) selectClip(selectedClipId, false, true);
    updateSelectionButtons();
    scheduleAutosave();
  };

  const toggleClipSelection = (clip) => {
    if (selectedClipIds.has(clip.id)) selectedClipIds.delete(clip.id);
    else selectedClipIds.add(clip.id);
    selectedClipId = [...selectedClipIds].at(-1) ?? null;
    const activeClip = [...timeline.video, ...timeline.audio].find((entry) => entry.id === selectedClipId);
    if (activeClip) {
      const item = media.find((entry) => entry.id === activeClip.mediaId);
      selectedMediaId = activeClip.mediaId;
      selectedTrackId = activeClip.trackId;
      activeSource = item?.file ? { ...item, clip: activeClip } : null;
      renderInspector(item ?? null, activeClip);
    } else {
      activeSource = null;
      renderInspector(null);
    }
    elements.trackRows.querySelectorAll(".timeline-clip").forEach((block) => {
      block.classList.toggle("selected", selectedClipIds.has(block.dataset.clipId));
    });
    updateSelectionButtons();
    scheduleAutosave();
  };

  const removeClips = (clipIds) => {
    const allClips = [...timeline.video, ...timeline.audio];
    const removedIds = new Set(clipIds);
    for (const clip of allClips) {
      if (removedIds.has(clip.id)) {
        for (const linked of linkedClipsFor(clip)) removedIds.add(linked.id);
      }
    }
    if (![...removedIds].some((id) => allClips.some((clip) => clip.id === id))) return;
    recordUndo();
    const ripple = document.querySelector("#ripple-toggle").checked;
    for (const kind of ["video", "audio"]) {
      const next = ripple
        ? editing.rippleDelete(timeline[kind], removedIds)
        : timeline[kind].filter((clip) => !removedIds.has(clip.id));
      timeline[kind].splice(0, timeline[kind].length, ...next);
    }
    selectedClipIds = new Set();
    selectedClipId = null;
    renderTimeline();
    const item = media.find((entry) => entry.id === selectedMediaId);
    renderInspector(item ?? null);
    scheduleAudioSources();
    scheduleAutosave();
  };

  const removeClip = (clipId) => removeClips(selectedClipIds.has(clipId) ? selectedClipIds : [clipId]);

  const updatePlayhead = () => {
    elements.playhead.style.left = `${187 + playheadTime * pixelsPerSecond()}px`;
  };

  const setPlayhead = (time) => {
    const snapped = Math.round((Number.isFinite(time) ? time : 0) * sequenceSettings.frameRate) / sequenceSettings.frameRate;
    playheadTime = Math.max(0, Math.min(snapped, sequenceDuration()));
    if (sequencePlaying) scheduleAudioSources();
    else if (sequenceDuration() > 0) syncVideoAtTime(playheadTime);
    updateTransport();
    updateSelectionButtons();
  };

  const updateTransport = () => {
    const duration = sequenceDuration();
    if (sequencePlaying || duration > 0) {
      elements.currentTime.textContent = formatTime(playheadTime);
      elements.durationTime.textContent = formatTime(duration);
      elements.seekSlider.value = duration > 0 ? String(Math.round((playheadTime / duration) * 1000)) : "0";
      elements.viewerTimecode.textContent = formatTimecode(playheadTime);
    } else {
      const element = sourceElement();
      elements.currentTime.textContent = formatTime(element?.currentTime ?? 0);
      elements.durationTime.textContent = formatTime(element?.duration ?? 0);
      elements.viewerTimecode.textContent = formatTimecode(element?.currentTime ?? 0);
      if (Number.isFinite(element?.duration) && element.duration > 0) {
        elements.seekSlider.value = String(Math.round((element.currentTime / element.duration) * 1000));
      }
    }
    updatePlayhead();
    updateSelectionButtons();
  };

  const stopScheduledAudio = () => {
    for (const player of audioPlayers.values()) {
      if (player.cleanupTimer) window.clearTimeout(player.cleanupTimer);
      try {
        const stopped = player.source.stop(audioContext?.currentTime);
        stopped?.catch((error) => console.error("Could not stop a timeline audio source:", error));
      } catch (error) {
        console.error("Could not stop a timeline audio source:", error);
      }
      player.source.disconnect();
      player.envelope.disconnect();
      player.gain.disconnect();
      player.analyser.disconnect();
    }
    audioPlayers.clear();
  };

  const updatePlaybackMode = () => {
    const mode = document.querySelector("#timeline-playback-mode");
    if (!sequencePlaying) {
      mode.textContent = "EDIT MODE";
      return;
    }
    const direction = playbackRate < 0 ? "REVERSE" : "PLAYING";
    const speed = Math.abs(playbackRate) === 1 ? "" : ` ${Math.abs(playbackRate)}×`;
    const dropped = droppedVideoFrames > 0 ? ` · ${droppedVideoFrames} DROPPED` : "";
    const reporting = droppedFrameReportingAvailable ? "" : " · DROP METRICS N/A";
    mode.textContent = `${direction}${speed}${dropped}${reporting}`;
  };

  const observeVideoFrames = (video) => {
    if (!("requestVideoFrameCallback" in video)) return;
    let stats = observedVideoFrames.get(video);
    if (stats?.scheduled) return;
    stats = stats ?? { clipId: null, presentedFrames: null, scheduled: false };
    stats.scheduled = true;
    observedVideoFrames.set(video, stats);
    const observe = (_now, metadata) => {
      stats.scheduled = false;
      if (!video.isConnected) return;
      const clipId = video.dataset.clipId ?? "primary";
      if (stats.clipId !== clipId || !Number.isFinite(stats.presentedFrames)) {
        stats.clipId = clipId;
        stats.presentedFrames = metadata.presentedFrames;
      } else if (sequencePlaying && playbackRate === 1 &&
        Number.isFinite(stats.presentedFrames) && Number.isFinite(metadata.presentedFrames)) {
        droppedVideoFrames += playbackClock.droppedFrameCount(stats.presentedFrames, metadata.presentedFrames);
        stats.presentedFrames = metadata.presentedFrames;
        updatePlaybackMode();
      }
      stats.scheduled = true;
      video.requestVideoFrameCallback(observe);
    };
    video.requestVideoFrameCallback(observe);
  };

  const scheduleAudioSources = async (leadSeconds = 0) => {
    if (!sequencePlaying) return 0;
    const token = ++audioScheduleToken;
    stopScheduledAudio();
    const startTime = playheadTime;
    const audibleClips = timeline.audio.filter((clip) => engine.clipEnd(clip) > startTime);
    const missingItems = new Set();
    const context = ensureAudioContext();
    const tunedNodes = new Map();

    for (const clip of audibleClips.filter((entry) => entry.autoTune?.enabled)) {
      const item = media.find((entry) => entry.id === clip.mediaId);
      const buffer = item && audioBuffers.get(item.id);
      if (!item?.file || !buffer) continue;
      tunedNodes.set(clip.id, await ensureAutoTuneNode(clip, buffer, context));
      if (token !== audioScheduleToken || !sequencePlaying) return 0;
    }
    const playbackStartAt = context.currentTime + (tunedNodes.size > 0 ? leadSeconds : 0);

    for (const clip of audibleClips) {
      const item = media.find((entry) => entry.id === clip.mediaId);
      if (!item?.file) {
        missingItems.add(item?.name ?? "a missing source");
        continue;
      }
      if (token !== audioScheduleToken || !sequencePlaying) return;
      const buffer = audioBuffers.get(item.id);
      if (!buffer) {
        missingItems.add(item.name);
        continue;
      }

      const fromTimeline = Math.max(startTime, clip.start);
      const elapsed = fromTimeline - clip.start;
      const sourceOffset = clip.sourceStart + elapsed;
      const playDuration = Math.min(engine.clipEnd(clip) - fromTimeline, buffer.duration - sourceOffset);
      if (playDuration <= 0) continue;

      const track = trackForClip(clip);
      const source = tunedNodes.get(clip.id) ?? context.createBufferSource();
      const isAutoTuned = tunedNodes.has(clip.id);
      if (!isAutoTuned) source.buffer = buffer;
      const envelope = context.createGain();
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(envelope);
      envelope.connect(gain);
      gain.connect(analyser);
      analyser.connect(masterGain);
      const scheduledAt = playbackStartAt + Math.max(0, clip.start - startTime);
      const fadeInValue = clip.fadeIn > elapsed ? elapsed / clip.fadeIn : 1;
      const remaining = clipDuration(clip) - elapsed;
      const fadeOutValue = clip.fadeOut > 0 ? Math.min(1, remaining / clip.fadeOut) : 1;
      envelope.gain.setValueAtTime(Math.max(0, Math.min(fadeInValue, fadeOutValue)), scheduledAt);
      if (elapsed < clip.fadeIn) {
        envelope.gain.linearRampToValueAtTime(1, scheduledAt + clip.fadeIn - elapsed);
      }
      if (clip.fadeOut > 0) {
        const fadeOutStart = clipDuration(clip) - clip.fadeOut;
        if (elapsed < fadeOutStart) {
          envelope.gain.setValueAtTime(1, scheduledAt + fadeOutStart - elapsed);
        }
        envelope.gain.linearRampToValueAtTime(0, scheduledAt + playDuration);
      }
      gain.gain.setValueAtTime(
        masterMuted ? 0 : (audioTrackIsAudible(track) && !clip.muted ? clip.volume * track.volume : 0),
        scheduledAt,
      );
      if (isAutoTuned) {
        await scheduleAutoTune(source, clip, sourceOffset, playDuration, scheduledAt);
      } else {
        source.start(scheduledAt, sourceOffset, playDuration);
      }
      if (token !== audioScheduleToken || !sequencePlaying) {
        try {
          const stopped = source.stop(context.currentTime);
          stopped?.catch((error) => console.error("Could not stop a cancelled audio schedule:", error));
        } catch (error) {
          console.error("Could not stop a cancelled audio schedule:", error);
        }
        source.disconnect();
        envelope.disconnect();
        gain.disconnect();
        analyser.disconnect();
        return 0;
      }
      const player = { source, envelope, gain, analyser, trackId: track.id, clip };
      audioPlayers.set(clip.id, player);
      if (isAutoTuned) {
        player.cleanupTimer = window.setTimeout(() => {
          if (audioPlayers.get(clip.id)?.source !== source) return;
          source.stop(context.currentTime).catch((error) => console.error("Could not stop Auto-Tune processing:", error));
          source.disconnect();
          envelope.disconnect();
          gain.disconnect();
          analyser.disconnect();
          audioPlayers.delete(clip.id);
        }, Math.max(0, (scheduledAt + playDuration - context.currentTime) * 1000 + 250));
      } else {
        source.addEventListener("ended", () => {
          if (audioPlayers.get(clip.id)?.source === source) {
            source.disconnect();
            envelope.disconnect();
            gain.disconnect();
            analyser.disconnect();
            audioPlayers.delete(clip.id);
          }
        }, { once: true });
      }
    }
    if (missingItems.size > 0) {
      showToast(`Audio playback unavailable for: ${[...missingItems].join(", ")}. Re-import supported source files.`);
    }
    refreshAudioGains();
    return tunedNodes.size > 0 ? leadSeconds : 0;
  };

  const syncVideoAtTime = (time) => {
    const candidates = engine.activeVideoClipsAtTime(timeline.video, tracks.video, time)
      .map(({ clip, trackIndex }) => ({
        clip,
        item: media.find((entry) => entry.id === clip.mediaId),
        trackIndex,
      }))
      .filter((candidate) => candidate.item?.file);
    const current = candidates.at(-1);
    const activeLayerIds = new Set(candidates.slice(0, -1).map(({ clip }) => clip.id));
    for (const [clipId, layer] of previewLayers) {
      if (!activeLayerIds.has(clipId)) {
        layer.video.pause();
        layer.video.removeAttribute("src");
        layer.video.load();
        layer.wrapper.remove();
        previewLayers.delete(clipId);
      }
    }
    if (!current) {
      elements.videoPreview.pause();
      elements.videoPreview.hidden = true;
      elements.videoPreview.style.opacity = "1";
      clearPreviewLayers();
      elements.audioArtwork.hidden = true;
      elements.viewerEmpty.hidden = false;
      elements.viewerEmpty.querySelector("p").textContent = sequencePlaying ? "Playing sequence" : "No video clip at this timeline position";
      elements.viewerEmpty.querySelector("small").textContent = "No video clip at this timeline position";
      elements.viewerSource.textContent = "Timeline preview";
      applyVideoClipStyle(null);
      activeVideoClipId = null;
      return;
    }
    const { clip, item } = current;
    const videoTime = clip.sourceStart + time - clip.start;
    applyVideoClipStyle(clip);
    const opacityForClip = (activeClip) => {
      const elapsed = time - activeClip.start;
      const length = clipDuration(activeClip);
      const transitionIn = activeClip.transitionIn ?? (activeClip.fadeIn > 0 ? "fade" : "cut");
      const transitionOut = activeClip.transitionOut ?? (activeClip.fadeOut > 0 ? "fade" : "cut");
      let opacity = 1;
      if (transitionIn === "fade" && activeClip.fadeIn > 0 && elapsed < activeClip.fadeIn) {
        opacity = Math.min(opacity, Math.max(0, elapsed / activeClip.fadeIn));
      }
      if (transitionOut === "fade" && activeClip.fadeOut > 0 && elapsed > length - activeClip.fadeOut) {
        opacity = Math.min(opacity, Math.max(0, (length - elapsed) / activeClip.fadeOut));
      }
      return opacity;
    };
    const syncLayerVideo = (video, layerClip, layerItem) => {
      const targetTime = layerClip.sourceStart + time - layerClip.start;
      video.muted = true;
      if (video.dataset.clipId !== layerClip.id || video.dataset.mediaUrl !== layerItem.url) {
        video.pause();
        video.src = layerItem.url;
        video.dataset.clipId = layerClip.id;
        video.dataset.mediaUrl = layerItem.url;
        observeVideoFrames(video);
        video.addEventListener("loadedmetadata", () => {
          if (video.dataset.clipId !== layerClip.id || video.dataset.mediaUrl !== layerItem.url) return;
          const currentTime = layerClip.sourceStart + playheadTime - layerClip.start;
          video.currentTime = Math.min(currentTime, video.duration || currentTime);
          if (sequencePlaying && sequenceClock && playbackRate > 0) {
            video.playbackRate = playbackRate;
            video.play().catch((error) => showToast(`Layered video playback failed: ${error.message}`));
          }
        }, { once: true });
      } else if (Number.isFinite(video.duration)) {
        if (Math.abs(video.currentTime - targetTime) > 0.5 / sequenceSettings.frameRate) {
          video.currentTime = Math.min(targetTime, video.duration || targetTime);
        }
        if (sequencePlaying && playbackRate > 0 && video.paused) {
          video.playbackRate = playbackRate;
          video.play().catch((error) => showToast(`Layered video playback failed: ${error.message}`));
        } else if (playbackRate < 0 && !video.paused) video.pause();
      }
    };
    for (const [layerIndex, candidate] of candidates.slice(0, -1).entries()) {
      let layer = previewLayers.get(candidate.clip.id);
      if (!layer) {
        const wrapper = document.createElement("div");
        wrapper.className = "video-preview-layer";
        const video = document.createElement("video");
        video.playsInline = true;
        video.preload = "metadata";
        const title = document.createElement("div");
        title.className = "video-title-overlay";
        wrapper.append(video, title);
        elements.viewerStage.insertBefore(wrapper, elements.videoPreview);
        layer = { wrapper, video, title };
        previewLayers.set(candidate.clip.id, layer);
      }
      const color = candidate.clip.color ?? defaultColor();
      layer.video.hidden = false;
      layer.video.style.zIndex = String((layerIndex + 1) * 2 + 1);
      layer.video.style.filter = `brightness(${1 + color.brightness}) contrast(${color.contrast}) saturate(${color.saturation}) hue-rotate(${color.hue}deg)`;
      layer.video.style.opacity = String(opacityForClip(candidate.clip));
      layer.title.style.zIndex = String((layerIndex + 1) * 2 + 2);
      applyTitleStyle(layer.title, candidate.clip, opacityForClip(candidate.clip));
      syncLayerVideo(layer.video, candidate.clip, candidate.item);
    }
    elements.viewerEmpty.hidden = true;
    elements.audioArtwork.hidden = true;
    elements.videoPreview.hidden = false;
    elements.videoPreview.style.zIndex = String(candidates.length * 2 + 1);
    elements.videoPreview.muted = sequencePlaying;
    elements.videoTitleOverlay.style.zIndex = String(candidates.length * 2 + 2);
    applyTitleStyle(elements.videoTitleOverlay, clip, opacityForClip(clip));
    elements.viewerSource.textContent = item.name;

    if (activeVideoClipId !== clip.id || elements.videoPreview.dataset.mediaUrl !== item.url) {
      elements.videoPreview.pause();
      elements.videoPreview.src = item.url;
      elements.videoPreview.dataset.mediaUrl = item.url;
      elements.videoPreview.dataset.clipId = clip.id;
      observeVideoFrames(elements.videoPreview);
      activeVideoClipId = clip.id;
      elements.videoPreview.addEventListener("loadedmetadata", () => {
        if (activeVideoClipId !== clip.id) return;
        elements.videoPreview.currentTime = Math.min(videoTime, elements.videoPreview.duration || videoTime);
        if (sequencePlaying && sequenceClock && playbackRate > 0) {
          elements.videoPreview.playbackRate = playbackRate;
          elements.videoPreview.play().catch((error) => showToast(`Video playback failed: ${error.message}`));
        }
      }, { once: true });
    } else if (Number.isFinite(elements.videoPreview.duration)) {
      if (Math.abs(elements.videoPreview.currentTime - videoTime) > 0.5 / sequenceSettings.frameRate) {
        elements.videoPreview.currentTime = videoTime;
      }
      if (sequencePlaying && playbackRate > 0 && elements.videoPreview.paused) {
        elements.videoPreview.playbackRate = playbackRate;
        elements.videoPreview.play().catch((error) => showToast(`Video playback failed: ${error.message}`));
      }
    }
  };

  const pauseSequence = () => {
    sequencePlaying = false;
    playbackRate = 1;
    audioScheduleToken += 1;
    cancelAnimationFrame(playbackFrame);
    cancelAnimationFrame(audioMeterFrame);
    stopScheduledAudio();
    elements.videoPreview.pause();
    for (const layer of previewLayers.values()) layer.video.pause();
    elements.videoPreview.playbackRate = 1;
    for (const layer of previewLayers.values()) layer.video.playbackRate = 1;
    elements.videoPreview.muted = false;
    elements.playButton.textContent = "▶";
    elements.playButton.setAttribute("aria-label", "Play");
    sequenceClock = null;
    updatePlaybackMode();
    if (audioContext?.state === "running") {
      audioContext.suspend().catch((error) => console.error("Could not suspend audio playback:", error));
    }
  };

  const startSequence = async () => {
    try {
      if (!sequencePlaying) return;
      const tunedClips = timeline.audio.filter((clip) =>
        clip.autoTune?.enabled && engine.clipEnd(clip) > playheadTime);
      if (tunedClips.length > 0 && (!window.isSecureContext || !window.AudioWorkletNode)) {
        throw new Error("Live Auto-Tune needs AudioWorklet in a secure browser context. Open this app on localhost or through trusted HTTPS, or disable Auto-Tune.");
      }
      const audioSources = [...new Map(timeline.audio
        .map((clip) => media.find((item) => item.id === clip.mediaId))
        .filter((item) => item?.file && item.size <= 80 * 1024 * 1024)
        .map((item) => [item.id, item])).values()];
      let audioAvailable = audioSources.length === 0;
      if (audioSources.length > 0 && playbackRate === 1) {
        try {
          const context = ensureAudioContext();
          await context.resume();
          await Promise.all(audioSources.map(ensureWaveform));
          if (!sequencePlaying) return;
          const tunedMedia = [...new Map(tunedClips
            .map((clip) => media.find((item) => item.id === clip.mediaId))
            .filter((item) => item?.file && audioBuffers.has(item.id))
            .map((item) => [item.id, item])).values()];
          await Promise.all(tunedMedia.map((item) => ensurePitchCurve(item)));
          if (!sequencePlaying) return;
          masterGain.gain.setValueAtTime(masterMuted ? 0 : Number(elements.volumeSlider.value), context.currentTime);
          audioAvailable = true;
        } catch (error) {
          console.error("Could not prepare sequence audio:", error);
          if (tunedClips.length > 0) throw error;
          showToast(`Audio playback is unavailable: ${error.message}`);
        }
      }
      if (!sequencePlaying) return;
      if (audioAvailable) {
        const lead = await scheduleAudioSources(0.15);
        if (lead > 0) await new Promise((resolve) => window.setTimeout(resolve, lead * 1000));
      }
      else showToast("Shuttle playback is video-only; return to normal-speed playback to hear the audio mix.");
      if (!sequencePlaying) return;
      syncVideoAtTime(playheadTime);
      const audioClockAvailable = audioAvailable && playbackRate === 1 && audioContext?.state === "running";
      const clockSource = audioClockAvailable ? "audio" : "performance";
      const clockStart = clockSource === "audio" ? audioContext.currentTime : performance.now() / 1000;
      sequenceClock = {
        source: clockSource,
        clockStart,
        timelineStart: playheadTime,
        rate: playbackRate,
      };
      droppedFrameReportingAvailable = true;
      droppedVideoFrames = 0;
      updatePlaybackMode();
      const activeVideos = [
        elements.videoPreview,
        ...[...previewLayers.values()].map((layer) => layer.video),
      ].filter((video) => !video.hidden && video.src);
      droppedFrameReportingAvailable = activeVideos.every((video) => "requestVideoFrameCallback" in video);
      updatePlaybackMode();
      for (const video of activeVideos) {
        const stats = observedVideoFrames.get(video);
        if (stats) {
          stats.clipId = video.dataset.clipId ?? "primary";
          stats.presentedFrames = null;
        }
      }
      if (playbackRate < 0) {
        for (const video of activeVideos) video.pause();
      } else {
        for (const video of activeVideos) {
          video.playbackRate = playbackRate;
          try {
            await video.play();
          } catch (error) {
            showToast(`Video playback failed: ${error.message}`);
          }
        }
      }
      if (audioAvailable) audioMeterFrame = requestAnimationFrame(drawAudioMeters);
      const tick = (now) => {
        if (!sequencePlaying) return;
        const duration = sequenceDuration();
        const clockNow = sequenceClock.source === "audio" ? audioContext.currentTime : now / 1000;
        const rawTime = playbackClock.sequenceTimeAtClock(sequenceClock, clockNow);
        const frameIndex = playbackClock.frameIndexAtTime(rawTime, sequenceSettings.frameRate);
        playheadTime = Math.max(0, Math.min(duration, playbackClock.frameTime(frameIndex, sequenceSettings.frameRate)));
        syncVideoAtTime(playheadTime);
        updateTransport();
        if ((playbackRate > 0 && playheadTime >= duration) || (playbackRate < 0 && playheadTime <= 0)) {
          const reachedStart = playbackRate < 0;
          pauseSequence();
          playheadTime = reachedStart ? 0 : duration;
          updateTransport();
          return;
        }
        playbackFrame = requestAnimationFrame(tick);
      };
      playbackFrame = requestAnimationFrame(tick);
    } catch (error) {
      pauseSequence();
      console.error("Could not start timeline playback:", error);
      showToast(`Could not play this sequence: ${error.message}`);
    }
  };

  const setPlayback = async () => {
    const hasTimeline = timeline.video.length + timeline.audio.length > 0;
    if (hasTimeline) {
      if (sequencePlaying) {
        pauseSequence();
        return;
      }
      playbackRate = 1;
      droppedVideoFrames = 0;
      if (playheadTime >= sequenceDuration()) playheadTime = 0;
      sequencePlaying = true;
      elements.playButton.textContent = "Ⅱ";
      elements.playButton.setAttribute("aria-label", "Pause");
      updatePlaybackMode();
      await startSequence();
      return;
    }

    const element = sourceElement();
    if (!activeSource) {
      showToast("Import and select a source before playing.");
      return;
    }
    if (element.paused) {
      try {
        await element.play();
      } catch (error) {
        showToast(`Playback failed: ${error.message}`);
      }
    } else {
      element.pause();
    }
  };

  const makeMediaFromProject = async (reference) => {
    const saved = await readRecord("assets", reference.id);
    const matchesReference = saved &&
      saved.name === reference.name &&
      saved.type === reference.type &&
      saved.size === reference.size &&
      saved.file instanceof Blob &&
      saved.file.name === reference.name &&
      saved.file.size === reference.size &&
      saved.file.type === reference.type;
    return {
      ...reference,
      file: matchesReference ? saved.file : null,
      url: matchesReference ? URL.createObjectURL(saved.file) : null,
      storageReady: Boolean(matchesReference),
    };
  };

  const applyProject = async (value, notify = true) => {
    const project = validateProject(value);
    const restoredMedia = await Promise.all(project.media.map(makeMediaFromProject));
    pauseSequence();
    stopScheduledAudio();
    clearAutoTuneNodes();
    clearPitchAnalysis();
    clearPreviewLayers();
    elements.videoPreview.pause();
    elements.audioPreview.pause();
    for (const item of media) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    media.splice(0, media.length, ...restoredMedia);
    for (const item of restoredMedia) probeDuration(item);
    timeline.video.splice(0, timeline.video.length, ...project.timeline.video);
    timeline.audio.splice(0, timeline.audio.length, ...project.timeline.audio);
    tracks.video.splice(0, tracks.video.length, ...project.tracks.video);
    tracks.audio.splice(0, tracks.audio.length, ...project.tracks.audio);
    audioBuffers.clear();
    waveformCache.clear();
    elements.projectName.textContent = project.name.trim() || "Untitled project";
    elements.volumeSlider.value = String(project.settings.previewVolume);
    timelineZoom = project.settings.timelineZoom;
    Object.assign(sequenceSettings, project.settings.sequence);
    if (masterGain) masterGain.gain.value = project.settings.previewVolume;
    playheadTime = Math.max(0, Math.min(project.settings.playheadTime, sequenceDuration()));
    activeVideoClipId = null;
    selectedTrackId = null;
    selectedClipId = [...timeline.video, ...timeline.audio].some((clip) => clip.id === project.selection.clipId)
      ? project.selection.clipId
      : null;
    selectedClipIds = new Set();
    const clip = [...timeline.video, ...timeline.audio].find((entry) => entry.id === selectedClipId);
    selectedMediaId = clip?.mediaId ?? (media.some((item) => item.id === project.selection.mediaId) ? project.selection.mediaId : null);
    activeSource = null;
    applyVideoClipStyle(null);
    elements.videoPreview.removeAttribute("src");
    elements.audioPreview.removeAttribute("src");
    elements.videoPreview.load();
    elements.audioPreview.load();
    elements.videoPreview.hidden = true;
    elements.audioPreview.hidden = true;
    elements.audioArtwork.hidden = true;
    elements.viewerEmpty.hidden = false;
    elements.viewerEmpty.querySelector("p").textContent = "Choose a clip from your library";
    elements.viewerEmpty.querySelector("small").textContent = "Your source preview will appear here";
    elements.viewerSource.textContent = "No source selected";
    elements.currentTime.textContent = "00:00";
    elements.durationTime.textContent = "00:00";
    elements.seekSlider.value = "0";
    elements.playButton.textContent = "▶";
    elements.playButton.setAttribute("aria-label", "Play");
    updateMuteButton(false);
    document.querySelector("#add-selected").disabled = true;
    renderMedia();
    renderTimeline();
    renderInspector(null);

    if (selectedClipId) selectClip(selectedClipId);
    else if (selectedMediaId) selectMedia(selectedMediaId);
    updateTransport();
    updateHistoryButtons();

    window.clearTimeout(saveTimer);
    let autosaved = true;
    try {
      await writeProjectToStorage();
      setSaveStatus("AUTOSAVED");
    } catch (error) {
      autosaved = false;
      handleStorageError(error);
    }

    const missing = media.filter((item) => !item.file).length;
    if (notify) {
      if (missing > 0) {
        showToast(`Project opened. ${missing} source file${missing === 1 ? " is" : "s are"} missing; import the originals to relink.${autosaved ? "" : " Browser autosave failed."}`);
      } else {
        showToast(autosaved ? "Project opened and autosaved in this browser." : "Project opened, but browser autosave failed.");
      }
    }
    return autosaved;
  };

  const renderTitleImage = async (title, width, height, style = defaultTitleStyle()) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const fontSize = Math.round(height * style.size / 100);
    const maxWidth = width * 0.84;
    context.font = `${style.weight} ${fontSize}px ${style.family}`;
    const [, vertical, horizontal] = style.position === "center"
      ? ["center", "center"]
      : style.position.match(/^(top|center|bottom)-(left|center|right)$/)?.slice(1) ?? ["bottom", "center"];
    context.textAlign = horizontal;
    context.textBaseline = "top";
    const lines = [];
    let line = "";
    for (const word of title.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    const lineHeight = Math.round(fontSize * 1.15);
    const maxLines = Math.max(1, Math.floor(height * 0.35 / lineHeight));
    const visibleLines = lines.slice(0, maxLines);
    if (visibleLines.length < lines.length) visibleLines[maxLines - 1] = `${visibleLines[maxLines - 1].slice(0, -1)}…`;
    const lineBlockHeight = lineHeight * visibleLines.length;
    const top = vertical === "top" ? height * 0.1 : vertical === "center" ? (height - lineBlockHeight) / 2 : height * 0.88 - lineBlockHeight;
    const x = horizontal === "left" ? width * 0.08 : horizontal === "right" ? width * 0.92 : width / 2;
    const widestLine = Math.max(...visibleLines.map((text) => context.measureText(text).width));
    if (style.background === "box") {
      const padding = Math.max(8, Math.round(fontSize * 0.25));
      const boxWidth = Math.min(maxWidth, widestLine + padding * 2);
      const boxX = horizontal === "left" ? x : horizontal === "right" ? x - boxWidth : x - boxWidth / 2;
      const boxY = top - padding / 2;
      context.fillStyle = "rgba(0, 0, 0, 0.58)";
      context.fillRect(boxX, boxY, boxWidth, lineBlockHeight + padding);
    }
    context.fillStyle = style.color;
    context.shadowColor = "rgba(0, 0, 0, 0.8)";
    context.shadowBlur = Math.max(4, Math.round(fontSize * 0.15));
    context.shadowOffsetY = Math.max(2, Math.round(fontSize * 0.06));
    visibleLines.forEach((text, index) => {
      context.fillText(text, x, top + index * lineHeight, maxWidth);
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The browser could not create a title overlay image.");
    return blob;
  };

  const setExportStatus = (message, progress = null) => {
    elements.exportStatus.textContent = message;
    elements.exportProgress.hidden = progress === null;
    if (progress !== null) elements.exportProgress.value = Math.max(0, Math.min(100, progress));
  };

  const runFFmpegCommand = async (engineInstance, args, operation) => {
    const exitCode = await engineInstance.exec(args);
    if (exitCode !== 0) throw new Error(`${operation} failed (FFmpeg exit code ${exitCode}).`);
  };

  const createExportEngine = async () => {
    const engineInstance = new FFmpeg();
    ffmpeg = engineInstance;
    engineInstance.on("progress", ({ progress }) => {
      if (exporting) setExportStatus(`${ffmpegProgressLabel} ${Math.round(progress * 100)}%`, progress * 100);
    });
    const coreURL = await toBlobURL(ffmpegCoreURL, "text/javascript");
    const wasmURL = await toBlobURL(ffmpegWasmURL, "application/wasm");
    try {
      setExportStatus("Loading in-browser render engine");
      await engineInstance.load({ coreURL, wasmURL });
    } finally {
      URL.revokeObjectURL(coreURL);
      URL.revokeObjectURL(wasmURL);
    }
    return engineInstance;
  };

  const revokeSeparationResult = () => {
    if (!separationResult) return;
    URL.revokeObjectURL(separationResult.videoUrl);
    URL.revokeObjectURL(separationResult.audioUrl);
    separationResult = null;
  };

  const separateSourceMedia = async (item, button) => {
    if (exporting) return;
    if (item.size > 256 * 1024 * 1024) {
      showToast("Source separation is limited to 256 MB in this browser. Use a smaller source video.");
      return;
    }

    const plan = buildSourceSeparationPlan(item);
    exporting = true;
    exportCancelled = false;
    ffmpegProgressLabel = "Separating media";
    let engineInstance = null;
    const tempPaths = [];
    const exportButton = document.querySelector("#export-button");
    button.disabled = true;
    button.textContent = "Separating…";
    exportButton.disabled = true;
    elements.cancelExport.hidden = false;
    elements.cancelExport.disabled = false;
    revokeSeparationResult();
    setExportStatus("Preparing source video", 0);

    try {
      engineInstance = ffmpeg ?? await createExportEngine();
      if (exportCancelled) return;
      ffmpeg = engineInstance;

      await ffmpeg.writeFile(plan.inputPath, new Uint8Array(await item.file.arrayBuffer()));
      tempPaths.push(plan.inputPath);
      if (exportCancelled) return;

      ffmpegProgressLabel = "Extracting audio";
      setExportStatus("Extracting audio stream", 1);
      await runFFmpegCommand(ffmpeg, plan.audioArgs, "Audio extraction");
      tempPaths.push(plan.audioPath);
      if (exportCancelled) return;

      ffmpegProgressLabel = "Creating silent video";
      setExportStatus("Creating silent video", 1);
      await runFFmpegCommand(ffmpeg, plan.videoArgs, "Silent video creation");
      tempPaths.push(plan.videoPath);
      if (exportCancelled) return;

      await runFFmpegCommand(ffmpeg, ["-v", "error", "-i", plan.videoPath, "-map", "0:v:0", "-f", "null", "-"], "Silent video validation");
      await runFFmpegCommand(ffmpeg, ["-v", "error", "-i", plan.audioPath, "-map", "0:a:0", "-f", "null", "-"], "Audio validation");
      const [videoOutput, audioOutput] = await Promise.all([
        ffmpeg.readFile(plan.videoPath),
        ffmpeg.readFile(plan.audioPath),
      ]);
      if (!(videoOutput instanceof Uint8Array) || videoOutput.byteLength === 0 ||
        !(audioOutput instanceof Uint8Array) || audioOutput.byteLength === 0) {
        throw new Error("The render engine produced an empty output file.");
      }

      separationResult = {
        mediaId: item.id,
        videoName: plan.videoName,
        audioName: plan.audioName,
        videoUrl: URL.createObjectURL(new Blob([videoOutput], { type: "video/mp4" })),
        audioUrl: URL.createObjectURL(new Blob([audioOutput], { type: "audio/mp4" })),
      };
      setExportStatus("Audio and silent video are ready", 100);
      showToast("Separation complete. Download the silent video and extracted audio from the inspector.");
    } catch (error) {
      if (exportCancelled) {
        setExportStatus("Separation cancelled");
        return;
      }
      console.error(`Could not separate audio from ${item.name}:`, error);
      setExportStatus("Separation failed");
      showToast(`Could not separate this video. It may have no audio stream or use an unsupported codec: ${error.message}`);
    } finally {
      if (engineInstance && ffmpeg === engineInstance && !exportCancelled) {
        for (const path of tempPaths) {
          try {
            await ffmpeg.deleteFile(path);
          } catch (error) {
            console.warn(`Could not remove temporary separation file ${path}:`, error);
          }
        }
      }
      exporting = false;
      ffmpegProgressLabel = "Rendering";
      exportButton.disabled = false;
      elements.cancelExport.hidden = true;
      elements.cancelExport.disabled = true;
      if (button.isConnected) {
        const selectedClip = [...timeline.video, ...timeline.audio]
          .find((clip) => clip.id === selectedClipId && clip.mediaId === item.id) ?? null;
        renderInspector(item, selectedClip);
      }
    }
  };

  const exportSequence = async () => {
    if (exporting) return;
    if (sequenceDuration() <= 0) {
      showToast("Add clips to the timeline before exporting.");
      return;
    }
    const preset = elements.exportPreset.value;
    const outputSequence = preset === "web-720"
      ? { width: 1280, height: 720, frameRate: 30, pixelAspect: 1 }
      : preset === "archive-1080"
        ? { width: 1920, height: 1080, frameRate: sequenceSettings.frameRate, pixelAspect: 1 }
        : { ...sequenceSettings };
    const videoClips = timeline.video.map((clip) => ({ ...clip }));
    const audioClips = timeline.audio.map((clip) => ({
      ...clip,
      ...(clip.autoTune ? { autoTune: { ...clip.autoTune } } : {}),
    }));
    const totalInputBytes = media.reduce((sum, item) => sum + (item.file && allTimelineMediaIds().has(item.id) ? item.size : 0), 0);
    if (totalInputBytes > 256 * 1024 * 1024) {
      showToast("Browser export is limited to 256 MB of source media per sequence. Use shorter or smaller source files.");
      return;
    }

    exporting = true;
    exportCancelled = false;
    ffmpegProgressLabel = "Rendering";
    let tempPaths = [];
    const exportButton = document.querySelector("#export-button");
    exportButton.disabled = true;
    elements.cancelExport.hidden = false;
    elements.cancelExport.disabled = false;
    setExportStatus("Preparing source media", 0);
    try {
      for (const clip of videoClips) {
        if (exportCancelled) throw new Error("Export cancelled.");
        if (clip.title) {
          clip.titleImage = await renderTitleImage(
            clip.title,
            outputSequence.width,
            outputSequence.height,
            { ...defaultTitleStyle(), ...clip.titleStyle },
          );
        }
      }
      if (exportCancelled) throw new Error("Export cancelled.");
      const hasSoloAudioTrack = tracks.audio.some((track) => track.solo);
      const tuningClips = audioClips.filter((clip) => {
        const track = tracks.audio.find((entry) => entry.id === clip.trackId);
        return clip.autoTune?.enabled && clip.volume > 0 && track && !track.muted &&
          (!hasSoloAudioTrack || track.solo) && !clip.muted && track.volume > 0;
      });
      const autoTuneEvents = new Map();
      for (const clip of tuningClips) {
        if (exportCancelled) throw new Error("Export cancelled.");
        const item = media.find((entry) => entry.id === clip.mediaId);
        if (!item?.file) throw new Error(`Relink “${item?.name ?? "missing media"}” before exporting.`);
        if (item.size > 80 * 1024 * 1024) {
          throw new Error(`Auto-Tune export is limited to audio files up to 80 MiB. ${item.name} is too large.`);
        }
        setExportStatus(`Analyzing Auto-Tune · ${item.name}`, 0);
        await ensureWaveform(item);
        const buffer = audioBuffers.get(item.id);
        if (!buffer) throw new Error(`Could not decode ${item.name} for Auto-Tune export.`);
        const frames = await ensurePitchCurve(item, buffer);
        autoTuneEvents.set(
          clip.id,
          buildAutoTuneEvents(frames, clip.autoTune, clip.sourceStart, clip.sourceEnd),
        );
      }
      if (exportCancelled) throw new Error("Export cancelled.");
      const plan = buildRenderPlan({
        duration: sequenceDuration(),
        sequence: outputSequence,
        videoClips,
        audioClips,
        videoTracks: tracks.video,
        audioTracks: tracks.audio,
        media,
        preset,
        autoTuneEvents,
      });
      tempPaths = [];
      const engineInstance = ffmpeg ?? await createExportEngine();
      if (exportCancelled) {
        if (ffmpeg === engineInstance) ffmpeg = null;
        return;
      }
      ffmpeg = engineInstance;
      for (const input of plan.inputs) {
        if (exportCancelled) throw new Error("Export cancelled.");
        await ffmpeg.writeFile(input.path, new Uint8Array(await input.file.arrayBuffer()));
        tempPaths.push(input.path);
      }
      tempPaths.push("framewave-export.mp4");
      setExportStatus("Rendering sequence", 1);
      await runFFmpegCommand(ffmpeg, plan.args, "Sequence render");
      const output = await ffmpeg.readFile("framewave-export.mp4");
      if (!(output instanceof Uint8Array) || output.byteLength === 0) throw new Error("The render engine returned an empty output file.");
      setExportStatus("Validating MP4 output", 98);
      await runFFmpegCommand(ffmpeg, ["-v", "error", "-i", "framewave-export.mp4", "-t", "1", "-f", "null", "-"], "Export validation");
      const blob = new Blob([output], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(elements.projectName.textContent || "Framewave export").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")}.mp4`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus(`Export complete · ${formatSize(blob.size)}`, 100);
    } catch (error) {
      console.error("Framewave video export failed:", error);
      if (exportCancelled) setExportStatus("Export cancelled");
      else {
        setExportStatus("Export failed");
        showToast(`Could not export this sequence: ${error.message}`);
      }
    } finally {
      if (ffmpeg && exporting && !exportCancelled) {
        for (const path of tempPaths) {
          try {
            await ffmpeg.deleteFile(path);
          } catch (error) {
            console.warn(`Could not remove temporary render file ${path}:`, error);
          }
        }
      }
      exporting = false;
      exportButton.disabled = false;
      elements.cancelExport.hidden = true;
      elements.cancelExport.disabled = true;
    }
  };

  const allTimelineMediaIds = () => new Set([...timeline.video, ...timeline.audio].map((clip) => clip.mediaId));

  const saveProjectFile = async () => {
    window.clearTimeout(saveTimer);
    const project = serializeProject();
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeName = project.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
    anchor.href = url;
    anchor.download = `${safeName || "Untitled project"}.framewave`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    let autosaved = true;
    try {
      await writeProjectToStorage();
      setSaveStatus("AUTOSAVED");
    } catch (error) {
      autosaved = false;
      console.error("Framewave browser autosave failed during project export:", error);
      setSaveStatus("STORAGE ERROR");
    }
    showToast(autosaved
      ? "Project file saved. Media files are referenced, not included."
      : "Project file downloaded, but browser autosave failed. Check browser storage space.");
  };

  const openProjectFile = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error("Project files must be smaller than 10 MB.");
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (error) {
      throw new Error(`Could not read the project file: ${error.message}`);
    }
    await applyProject(data);
    undoStack.length = 0;
    redoStack.length = 0;
    updateHistoryButtons();
  };

  const restoreAutosave = async () => {
    const saved = await readRecord("projects", "current");
    if (!saved?.project) {
      setSaveStatus("READY");
      return;
    }
    const autosaved = await applyProject(saved.project, false);
    const missing = media.filter((item) => !item.file).length;
    const restoredMessage = missing > 0
      ? `Autosave restored; ${missing} source file${missing === 1 ? " is" : "s are"} missing.`
      : "Restored the latest autosaved project.";
    showToast(autosaved ? restoredMessage : `${restoredMessage} Browser autosave failed.`);
  };

  document.querySelector("#import-button").addEventListener("click", () => elements.fileInput.click());
  document.querySelector("#empty-import").addEventListener("click", () => elements.fileInput.click());
  document.querySelectorAll(".rail-button[data-workspace]").forEach((button) => {
    button.addEventListener("click", () => {
      const workspace = button.dataset.workspace;
      if (!["media", "edit", "audio"].includes(workspace)) {
        throw new Error(`Unknown editor workspace: ${workspace}`);
      }
      elements.workspace.dataset.workspace = workspace;
      document.querySelectorAll(".rail-button[data-workspace]").forEach((other) => {
        const active = other === button;
        other.classList.toggle("active", active);
        other.setAttribute("aria-pressed", String(active));
      });
    });
  });
  elements.fileInput.addEventListener("change", (event) => {
    addFiles(event.target.files).catch(handleStorageError);
    event.target.value = "";
  });
  elements.openProject.addEventListener("click", () => elements.projectInput.click());
  elements.projectInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file && media.length > 0 && !window.confirm("Open this project and replace the current project? Autosave will be updated.")) {
      event.target.value = "";
      return;
    }
    openProjectFile(file).catch((error) => showToast(error.message));
    event.target.value = "";
  });
  elements.saveProject.addEventListener("click", () => {
    saveProjectFile().catch((error) => {
      console.error("Framewave project export failed:", error);
      setSaveStatus("STORAGE ERROR");
      showToast(`Could not save the project file: ${error.message}`);
    });
  });

  document.querySelector("#new-project").addEventListener("click", () => {
    const name = window.prompt("Name your project", "Untitled project");
    if (name === null) return;
    if (media.length > 0 && !window.confirm("Start a new project? This clears the current media library and timeline.")) return;
    recordUndo();
    pauseSequence();
    stopScheduledAudio();
    clearAutoTuneNodes();
    clearPitchAnalysis();
    clearPreviewLayers();
    elements.videoPreview.pause();
    elements.audioPreview.pause();
    for (const item of media) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    media.length = 0;
    elements.projectName.textContent = name.trim() || "Untitled project";
    Object.assign(sequenceSettings, { width: 1920, height: 1080, frameRate: 24, pixelAspect: 1 });
    elements.exportPreset.value = "sequence";
    timeline.video.length = 0;
    timeline.audio.length = 0;
    tracks.video.splice(0, tracks.video.length, { id: "V1", kind: "video", muted: false, solo: false, volume: 1 });
    tracks.audio.splice(0, tracks.audio.length, { id: "A1", kind: "audio", muted: false, solo: false, volume: 1 });
    waveformCache.clear();
    audioBuffers.clear();
    selectedClipId = null;
    selectedClipIds = new Set();
    selectedMediaId = null;
    selectedTrackId = null;
    activeSource = null;
    activeVideoClipId = null;
    playheadTime = 0;
    elements.videoPreview.removeAttribute("src");
    elements.audioPreview.removeAttribute("src");
    elements.videoPreview.load();
    elements.audioPreview.load();
    elements.videoPreview.hidden = true;
    elements.audioPreview.hidden = true;
    elements.audioArtwork.hidden = true;
    elements.viewerEmpty.hidden = false;
    elements.viewerSource.textContent = "No source selected";
    elements.currentTime.textContent = "00:00";
    elements.durationTime.textContent = "00:00";
    elements.seekSlider.value = "0";
    document.querySelector("#add-selected").disabled = true;
    elements.playButton.textContent = "▶";
    elements.playButton.setAttribute("aria-label", "Play");
    applyVideoClipStyle(null);
    renderTimeline();
    renderInspector(null);
    renderMedia();
    scheduleAutosave();
  });
  document.querySelector("#export-button").addEventListener("click", () => exportSequence());
  elements.cancelExport.addEventListener("click", () => {
    if (!exporting) return;
    exportCancelled = true;
    exporting = false;
    ffmpeg?.terminate();
    ffmpeg = null;
    elements.cancelExport.disabled = true;
    setExportStatus("Cancelling operation");
  });
  document.querySelector("#sequence-settings-button").addEventListener("click", () => {
    document.querySelector("#sequence-width").value = String(sequenceSettings.width);
    document.querySelector("#sequence-height").value = String(sequenceSettings.height);
    document.querySelector("#sequence-frame-rate").value = String(sequenceSettings.frameRate);
    document.querySelector("#sequence-pixel-aspect").value = String(sequenceSettings.pixelAspect);
    document.querySelector("#sequence-settings-dialog").showModal();
  });
  document.querySelector("#sequence-settings-dialog").addEventListener("close", (event) => {
    const dialog = event.currentTarget;
    if (dialog.returnValue !== "save") return;
    const form = document.querySelector("#sequence-settings-form");
    if (!form.checkValidity()) {
      showToast("Sequence dimensions must be valid even-numbered values.");
      return;
    }
    recordUndo();
    Object.assign(sequenceSettings, {
      width: Number(document.querySelector("#sequence-width").value),
      height: Number(document.querySelector("#sequence-height").value),
      frameRate: Number(document.querySelector("#sequence-frame-rate").value),
      pixelAspect: Number(document.querySelector("#sequence-pixel-aspect").value),
    });
    setPlayhead(playheadTime);
    renderTimeline();
    scheduleAutosave();
  });
  document.querySelector("#add-selected").addEventListener("click", () => addToTimeline(selectedMediaId));
  document.querySelector("#add-audio-track").addEventListener("click", () => createTrack("audio"));
  document.querySelector("#add-video-track").addEventListener("click", () => createTrack("video"));
  document.querySelector("#split-at-playhead").addEventListener("click", splitSelectedAtPlayhead);
  document.querySelector("#link-clips").addEventListener("click", linkSelectedClips);
  document.querySelector("#unlink-clips").addEventListener("click", unlinkSelectedClips);
  document.querySelector("#undo-button").addEventListener("click", () => restoreHistory(undoStack, redoStack, "Undid edit").catch(handleStorageError));
  document.querySelector("#redo-button").addEventListener("click", () => restoreHistory(redoStack, undoStack, "Redid edit").catch(handleStorageError));
  elements.searchInput.addEventListener("input", renderMedia);

  document.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeFilter = tab.dataset.filter;
      document.querySelectorAll(".filter-tab").forEach((other) => {
        const active = other === tab;
        other.classList.toggle("active", active);
        other.setAttribute("aria-selected", String(active));
      });
      renderMedia();
    });
  });

  document.querySelector("#play-button").addEventListener("click", setPlayback);
  document.querySelector("#skip-back").addEventListener("click", () => {
    if (sequenceDuration() > 0) setPlayhead(0);
    else if (activeSource) sourceElement().currentTime = 0;
  });
  document.querySelector("#skip-end").addEventListener("click", () => {
    if (sequenceDuration() > 0) setPlayhead(sequenceDuration());
    else {
      const element = sourceElement();
      if (activeSource && Number.isFinite(element.duration)) element.currentTime = element.duration;
    }
  });
  elements.seekSlider.addEventListener("input", () => {
    const ratio = Number(elements.seekSlider.value) / 1000;
    if (sequenceDuration() > 0) setPlayhead(ratio * sequenceDuration());
    else {
      const element = sourceElement();
      if (activeSource && Number.isFinite(element.duration)) element.currentTime = ratio * element.duration;
    }
  });
  document.querySelector("#timeline-ruler").addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = elements.timelineRuler.getBoundingClientRect();
    setPlayhead(Math.max(0, (event.clientX - rect.left + elements.timelineCanvas.scrollLeft) / pixelsPerSecond()));
  });
  document.querySelector("#zoom-out").addEventListener("click", () => {
    recordUndo();
    timelineZoom = Math.max(25, timelineZoom - 25);
    renderTimeline();
    scheduleAutosave();
  });
  document.querySelector("#zoom-in").addEventListener("click", () => {
    recordUndo();
    timelineZoom = Math.min(400, timelineZoom + 25);
    renderTimeline();
    scheduleAutosave();
  });
  elements.volumeSlider.addEventListener("input", () => {
    const element = sourceElement();
    if (activeSource && !sequencePlaying) element.volume = Number(elements.volumeSlider.value);
    if (masterGain && !masterMuted) masterGain.gain.setTargetAtTime(Number(elements.volumeSlider.value), audioContext.currentTime, 0.015);
    scheduleAutosave();
  });
  elements.muteButton.addEventListener("click", () => {
    if (sequencePlaying) {
      masterMuted = !masterMuted;
      if (masterGain && audioContext) masterGain.gain.setTargetAtTime(masterMuted ? 0 : Number(elements.volumeSlider.value), audioContext.currentTime, 0.015);
      updateMuteButton(masterMuted);
      return;
    }
    const element = sourceElement();
    if (!activeSource) return;
    const selectedClip = [...timeline.video, ...timeline.audio].find((clip) => clip.id === selectedClipId);
    if (selectedClip) recordUndo();
    element.muted = !element.muted;
    if (selectedClip) {
      selectedClip.muted = element.muted;
      const muteControl = document.querySelector("#clip-muted");
      if (muteControl) muteControl.checked = element.muted;
    }
    updateMuteButton(element.muted);
    scheduleAutosave();
  });

  document.querySelector("#volume-slider").addEventListener("pointerup", () => {
    document.querySelector("#volume-slider").dataset.historyRecorded = "";
  });
  document.querySelector("#volume-slider").addEventListener("pointercancel", () => {
    document.querySelector("#volume-slider").dataset.historyRecorded = "";
  });
  document.querySelector("#volume-slider").addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) &&
      !event.currentTarget.dataset.historyRecorded) {
      recordUndo();
      event.currentTarget.dataset.historyRecorded = "true";
    }
  });
  document.querySelector("#volume-slider").addEventListener("keyup", () => {
    document.querySelector("#volume-slider").dataset.historyRecorded = "";
  });
  document.querySelector("#volume-slider").addEventListener("pointerdown", (event) => {
    const slider = event.currentTarget;
    if (slider.dataset.historyRecorded) return;
    recordUndo();
    slider.dataset.historyRecorded = "true";
  });

  window.addEventListener("pointermove", handleClipPointerMove);
  window.addEventListener("pointerup", finishClipPointer);
  window.addEventListener("pointerup", () => {
    document.querySelectorAll("[data-history-recorded]").forEach((input) => { input.dataset.historyRecorded = ""; });
  });
  window.addEventListener("pointercancel", finishClipPointer);
  window.addEventListener("pointercancel", () => {
    document.querySelectorAll("[data-history-recorded]").forEach((input) => { input.dataset.historyRecorded = ""; });
  });
  window.addEventListener("blur", finishClipPointer);

  for (const element of [elements.videoPreview, elements.audioPreview]) {
    element.addEventListener("timeupdate", updateTransport);
    element.addEventListener("loadedmetadata", updateTransport);
    element.addEventListener("play", () => {
      elements.playButton.textContent = "Ⅱ";
      elements.playButton.setAttribute("aria-label", "Pause");
    });
    element.addEventListener("pause", () => {
      elements.playButton.textContent = "▶";
      elements.playButton.setAttribute("aria-label", "Play");
    });
    element.addEventListener("ended", updateTransport);
  }

  const dropTarget = document.querySelector(".media-panel");
  dropTarget.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropTarget.classList.add("drag-over");
  });
  dropTarget.addEventListener("dragleave", (event) => {
    if (!dropTarget.contains(event.relatedTarget)) dropTarget.classList.remove("drag-over");
  });
  dropTarget.addEventListener("drop", (event) => {
    event.preventDefault();
    dropTarget.classList.remove("drag-over");
    addFiles(event.dataTransfer.files).catch(handleStorageError);
  });
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const isTyping = event.target.closest("input, textarea, select, [contenteditable='true']");
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      elements.searchInput.focus();
    } else if (!isTyping && (event.metaKey || event.ctrlKey) && key === "z") {
      event.preventDefault();
      const source = event.shiftKey ? redoStack : undoStack;
      const destination = event.shiftKey ? undoStack : redoStack;
      restoreHistory(source, destination, event.shiftKey ? "Redid edit" : "Undid edit").catch(handleStorageError);
    } else if (!isTyping && (event.metaKey || event.ctrlKey) && key === "y") {
      event.preventDefault();
      restoreHistory(redoStack, undoStack, "Redid edit").catch(handleStorageError);
    } else if (!isTyping && (event.key === "Delete" || event.key === "Backspace") && selectedClipId) {
      event.preventDefault();
      removeClips(selectedClipIds.size > 0 ? selectedClipIds : [selectedClipId]);
    } else if (!isTyping && !event.metaKey && !event.ctrlKey && !event.altKey && key === "s" && selectedClipIds.size > 0) {
      event.preventDefault();
      splitSelectedAtPlayhead();
    } else if (!isTyping && !event.metaKey && !event.ctrlKey && !event.altKey && key === "j") {
      event.preventDefault();
      setShuttlePlayback(-1);
    } else if (!isTyping && !event.metaKey && !event.ctrlKey && !event.altKey && key === "k") {
      event.preventDefault();
      if (sequencePlaying) pauseSequence();
      else sourceElement().pause();
    } else if (!isTyping && !event.metaKey && !event.ctrlKey && !event.altKey && key === "l") {
      event.preventDefault();
      setShuttlePlayback(1);
    } else if (!isTyping && !["BUTTON", "A"].includes(event.target.tagName) && event.key === "ArrowLeft") {
      event.preventDefault();
      stepFrame(-1);
    } else if (!isTyping && !["BUTTON", "A"].includes(event.target.tagName) && event.key === "ArrowRight") {
      event.preventDefault();
      stepFrame(1);
    } else if (event.code === "Space" && !["INPUT", "BUTTON"].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      setPlayback();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (restoring || document.visibilityState !== "hidden") return;
    window.clearTimeout(saveTimer);
    writeProjectToStorage().then(() => setSaveStatus("AUTOSAVED")).catch(handleStorageError);
  });

  renderMedia();
  renderTimeline();
  elements.workspace.inert = true;
  elements.openProject.disabled = true;
  elements.saveProject.disabled = true;
  document.querySelector("#new-project").disabled = true;
  document.querySelector("#import-button").disabled = true;
  elements.emptyImport.disabled = true;
  elements.fileInput.disabled = true;
  elements.projectInput.disabled = true;
  restoreAutosave().catch(handleStorageError).finally(() => {
    restoring = false;
    elements.workspace.inert = false;
    elements.openProject.disabled = false;
    elements.saveProject.disabled = false;
    document.querySelector("#new-project").disabled = false;
    document.querySelector("#import-button").disabled = false;
    elements.emptyImport.disabled = false;
    elements.fileInput.disabled = false;
    elements.projectInput.disabled = false;
  });
})();
