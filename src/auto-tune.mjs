export const PITCH_SAMPLE_RATE = 8000;
export const PITCH_FRAME_SIZE = 1024;
export const PITCH_HOP_SIZE = 256;
export const PITCH_FRAME_HOP_SECONDS = PITCH_HOP_SIZE / PITCH_SAMPLE_RATE;
export const PITCH_FRAME_OFFSET_SECONDS = PITCH_FRAME_SIZE / 2 / PITCH_SAMPLE_RATE;

const MIN_LAG = 10;
const MAX_LAG = 160;
const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

export const analyzePitch = (samples, sampleRate = PITCH_SAMPLE_RATE) => {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 4000) {
    throw new Error("Pitch analysis requires mono audio sampled at 4 kHz or higher.");
  }
  const frameCount = Math.max(1, Math.ceil(Math.max(0, samples.length - PITCH_FRAME_SIZE) / PITCH_HOP_SIZE) + 1);
  const result = new Float32Array(frameCount * 2);
  const differences = new Float64Array(MAX_LAG + 1);
  const normalized = new Float64Array(MAX_LAG + 1);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * PITCH_HOP_SIZE;
    let energy = 0;
    for (let index = 0; index < PITCH_FRAME_SIZE; index += 1) {
      const sample = samples[offset + index] ?? 0;
      energy += sample * sample;
    }
    if (energy / PITCH_FRAME_SIZE < 0.00001) continue;

    let cumulative = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 1) {
      let difference = 0;
      for (let index = 0; index < PITCH_FRAME_SIZE - lag; index += 1) {
        const delta = (samples[offset + index] ?? 0) - (samples[offset + index + lag] ?? 0);
        difference += delta * delta;
      }
      differences[lag] = difference;
      cumulative += difference;
      normalized[lag] = difference * (lag - MIN_LAG + 1) / Math.max(cumulative, 1e-12);
    }

    let bestLag = -1;
    for (let lag = MIN_LAG + 1; lag < MAX_LAG; lag += 1) {
      if (normalized[lag] < 0.16 && normalized[lag] <= normalized[lag - 1] && normalized[lag] <= normalized[lag + 1]) {
        bestLag = lag;
        break;
      }
    }
    if (bestLag < 0) {
      let bestScore = Number.POSITIVE_INFINITY;
      for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 1) {
        if (normalized[lag] < bestScore) {
          bestScore = normalized[lag];
          bestLag = lag;
        }
      }
      if (bestScore > 0.3) continue;
    }

    const left = normalized[bestLag - 1];
    const center = normalized[bestLag];
    const right = normalized[bestLag + 1];
    const curvature = left - 2 * center + right;
    const refinedLag = bestLag + (curvature === 0 ? 0 : 0.5 * (left - right) / curvature);
    const frequency = sampleRate / refinedLag;
    const confidence = 1 - center;
    if (frequency >= 50 && frequency <= 800 && confidence >= 0.55) {
      result[frame * 2] = frequency;
      result[frame * 2 + 1] = confidence;
    }
  }

  return result;
};

export const getCorrectionSemitones = (frequency, key, scale, amount = 100) => {
  const intervals = SCALES[scale];
  if (!Number.isFinite(frequency) || frequency < 50 || frequency > 800 || !intervals || !Number.isInteger(key) || key < 0 || key > 11) {
    return 0;
  }
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const nearestNote = Math.round(midi);
  let target = nearestNote;
  let distance = Number.POSITIVE_INFINITY;
  for (let note = nearestNote - 12; note <= nearestNote + 12; note += 1) {
    if (!intervals.includes((note - key + 120) % 12)) continue;
    const candidateDistance = Math.abs(midi - note);
    if (candidateDistance < distance) {
      target = note;
      distance = candidateDistance;
    }
  }
  const strength = Math.max(0, Math.min(100, amount)) / 100;
  const correction = Math.max(-6, Math.min(6, (target - midi) * strength));
  return Math.abs(correction) < 0.01 ? 0 : correction;
};

export const buildAutoTuneEvents = (pitchFrames, settings, sourceStart = 0, sourceEnd = Number.POSITIVE_INFINITY) => {
  if (!(pitchFrames instanceof Float32Array) || pitchFrames.length % 2 !== 0) {
    throw new Error("Pitch analysis returned invalid frame data.");
  }
  const events = [];
  let previous = 0;
  for (let index = 0; index < pitchFrames.length / 2; index += 1) {
    const time = index * PITCH_FRAME_HOP_SECONDS + PITCH_FRAME_OFFSET_SECONDS;
    if (time < sourceStart || time >= sourceEnd) continue;
    const frequency = pitchFrames[index * 2];
    const confidence = pitchFrames[index * 2 + 1];
    const correction = confidence >= 0.6
      ? getCorrectionSemitones(frequency, settings.key, settings.scale, settings.amount)
      : 0;
    if (Math.abs(correction - previous) >= 0.15) {
      events.push({ time, semitones: correction });
      previous = correction;
    }
  }
  return events;
};
