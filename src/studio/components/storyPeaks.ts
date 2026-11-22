// Peaks for stories: a decaying, noisy tone as a peaks pyramid (`buildMips`), deterministic so captures don't change.
import { buildMips, type PeakMips } from "../../plugins/audio/editor/music/peaksMip";

export function storyPeaks(seconds = 2.6, rate = 48000, channels = 1): PeakMips {
  const binFrames = 256;
  const frames = Math.round(seconds * rate);
  const bins = Math.ceil(frames / binFrames);
  const data = new Int16Array(channels * bins * 2);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let c = 0; c < channels; c++) {
    for (let b = 0; b < bins; b++) {
      const t = (b * binFrames) / rate;
      const env = Math.min(1, t * 20) * Math.exp(-t * 0.6) * (0.6 + 0.4 * Math.sin(t * 9));
      const a = env * (0.55 + 0.45 * rand());
      data[(c * bins + b) * 2] = Math.round(-a * 32767);
      data[(c * bins + b) * 2 + 1] = Math.round(a * 32767);
    }
  }
  return { rate, channels, frames, levels: buildMips({ binFrames, bins, channels, data }) };
}
