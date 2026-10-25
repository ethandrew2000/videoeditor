import { analyzePitch } from "./auto-tune.mjs";

self.addEventListener("message", (event) => {
  const { id, samples, sampleRate } = event.data;
  try {
    const frames = analyzePitch(samples, sampleRate);
    self.postMessage({ id, frames }, [frames.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});
