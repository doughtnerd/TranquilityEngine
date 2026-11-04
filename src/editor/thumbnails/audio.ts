// Audio clip summaries for the Assets panel and the Inspector (ADR 0061): waveform peaks, length,
// channels and sample rate, decoded with the browser's Web Audio (editor code; games use Howler).

export interface AudioSummary {
  /** Loudest absolute sample in each slice of the clip, 0–1, across channels. */
  peaks: number[];
  /** Seconds. */
  duration: number;
  channels: number;
  sampleRate: number;
}

/** How many slices a waveform has. */
export const PEAK_COUNT = 200;

/** The loudest absolute sample per slice, over every channel, rounded to 3 decimals. */
export function computePeaks(channels: readonly Float32Array[], count = PEAK_COUNT): number[] {
  const length = channels[0]?.length ?? 0;
  const peaks = new Array<number>(count).fill(0);
  if (!length) return peaks;
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * length) / count));
    let peak = 0;
    for (const data of channels) for (let j = from; j < to && j < length; j++) peak = Math.max(peak, Math.abs(data[j]));
    peaks[i] = Math.round(Math.min(1, peak) * 1000) / 1000;
  }
  return peaks;
}

/** Decode a clip's bytes and summarise it. Browser only (Web Audio). */
export async function decodeAudioSummary(bytes: Uint8Array): Promise<AudioSummary> {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx) throw new Error("This browser can't decode audio (no Web Audio).");
  // An offline context decodes without needing a user gesture or an output device.
  const ctx = new Ctx(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return { peaks: computePeaks(channels), duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate };
}

/** A summary as the cache stores it (`<key>.peaks.json`), and back. */
export const encodeSummary = (s: AudioSummary): Uint8Array => new TextEncoder().encode(JSON.stringify({ format: "myco.peaks@1", ...s }));

export function decodeSummary(bytes: Uint8Array): AudioSummary | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Partial<AudioSummary> & { format?: string };
    if (v.format !== "myco.peaks@1" || !Array.isArray(v.peaks) || typeof v.duration !== "number") return null;
    return { peaks: v.peaks.map(Number), duration: v.duration, channels: Number(v.channels) || 1, sampleRate: Number(v.sampleRate) || 0 };
  } catch {
    return null;
  }
}
