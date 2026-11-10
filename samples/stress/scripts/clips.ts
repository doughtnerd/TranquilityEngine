import { Assets, type AssetSource } from "myco";

/**
 * The storm's clips, synthesised in the page and served to the audio core as blob URLs through a runtime asset source.
 *
 * Why not commit them: architecture 6.5 wants at least 64 MB of distinct clips played in shuffled order, so the mixer's reads
 * miss the cache. Committed, that is 64 MB of repository and of every build; generated, it is nothing, and every machine
 * runs the same bytes (the generator is seeded). The audio core can't tell a blob URL from a file: it fetches and decodes
 * it like any asset, into its arena, and plays it through the same path.
 *
 * Two kinds, both mono 16-bit PCM at 48 kHz (decoded size = file size, no resampling):
 * - hits: many short clips (0.3 to 1.4 s) of different pitch and timbre, each a distinct arena entry (60% of the memory);
 * - beds: a few long clips (20 to 80 s) played quietly, so a voice lives for a minute and thousands are live at once.
 */
export interface ClipSet {
  hits: string[];
  beds: string[];
  /** Mean seconds a bed voice lives at pitch 1 (the clips' mean length). */
  meanBedSeconds: number;
  /** Decoded bytes of every clip generated so far. */
  bytes: number;
}

const RATE = 48_000;
const TAU = Math.PI * 2;
const SOURCE_KEY = "__stressClipSource";

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 16-bit mono WAV blob URL for `samples`. */
function wavUrl(samples: Int16Array): string {
  const bytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, bytes, true);
  new Int16Array(buf, 44, samples.length).set(samples);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/** One hit: three partials and a noise burst under an exponential decay, 5 ms attack, tail faded to zero. */
function hit(index: number): Int16Array {
  const r = rng(1000 + index);
  const n = Math.round((0.3 + r() * 1.1) * RATE);
  const out = new Int16Array(n);
  const f0 = 80 * Math.pow(2, r() * 4.5);
  const partials = [1, 1.5 + r(), 2.5 + r() * 2].map((k, i) => ({ w: (TAU * f0 * k) / RATE, a: 0.5 / (i + 1) }));
  const decay = 1 / (0.08 + r() * 0.4);
  const noise = 0.1 + r() * 0.4;
  let seed = index * 7919 + 1;
  const attack = Math.round(0.005 * RATE);
  const fade = Math.round(0.02 * RATE);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    let s = noise * ((seed >>> 8) / 8388608 - 1) * Math.exp((-i / RATE) * decay * 4);
    for (const p of partials) s += p.a * Math.sin(p.w * i);
    s *= Math.exp((-i / RATE) * decay) * Math.min(1, i / attack, (n - i) / fade) * 0.7;
    out[i] = Math.max(-32767, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}

/** One bed: a slow chord with a tremolo, `seconds` long. */
function bed(index: number, seconds: number): Int16Array {
  const r = rng(5000 + index);
  const n = Math.round(seconds * RATE);
  const out = new Int16Array(n);
  const f = 110 * Math.pow(2, r() * 2);
  const w1 = (TAU * f) / RATE;
  const w2 = (TAU * f * 1.5) / RATE;
  const lfo = (TAU * (0.1 + r())) / RATE;
  const fade = Math.round(0.05 * RATE);
  for (let i = 0; i < n; i++) {
    const s = 0.3 * (Math.sin(w1 * i) + 0.7 * Math.sin(w2 * i)) * (0.7 + 0.3 * Math.sin(lfo * i)) * Math.min(1, i / fade, (n - i) / fade);
    out[i] = Math.round(s * 32767);
  }
  return out;
}

/** Bed lengths in seconds before scaling to the memory budget (their sum at 48 kHz mono is 26.9 MB). */
const BED_SECONDS = [20, 30, 40, 50, 60, 80];

/**
 * Generates `totalMB` MB of clips (40% beds, 60% hits) a few milliseconds at a time: call `step` once per frame until it
 * returns true. The clips are registered as they are made.
 */
export function generateClips(totalMB: number): { set: ClipSet; step(budgetMs: number): boolean; progress(): number } {
  const total = totalMB * 1024 * 1024;
  const scale = (total * 0.4) / (BED_SECONDS.reduce((a, b) => a + b, 0) * RATE * 2);
  const bedSeconds = BED_SECONDS.map((s) => s * scale);
  const hitCount = Math.max(8, Math.round((total * 0.6) / (0.85 * RATE * 2)));
  const urls = new Map<string, string>();

  const source: AssetSource = { has: (p) => urls.has(p), get: (p) => urls.get(p) };
  const w = globalThis as unknown as Record<string, AssetSource | undefined>;
  const old = w[SOURCE_KEY];
  if (old) Assets.removeSource(old);
  w[SOURCE_KEY] = source;
  Assets.addSource(source);

  const set: ClipSet = { hits: [], beds: [], meanBedSeconds: bedSeconds.reduce((a, b) => a + b, 0) / bedSeconds.length, bytes: 0 };
  const jobs: (() => void)[] = [];
  bedSeconds.forEach((s, i) =>
    jobs.push(() => {
      const samples = bed(i, s);
      const path = `gen/bed-${i}.wav`;
      urls.set(path, wavUrl(samples));
      set.beds.push(path);
      set.bytes += samples.length * 2;
    }),
  );
  for (let i = 0; i < hitCount; i++) {
    jobs.push(() => {
      const samples = hit(i);
      const path = `gen/hit-${i}.wav`;
      urls.set(path, wavUrl(samples));
      set.hits.push(path);
      set.bytes += samples.length * 2;
    });
  }
  let next = 0;
  return {
    set,
    progress: () => next / jobs.length,
    step(budgetMs: number): boolean {
      const end = performance.now() + budgetMs;
      while (next < jobs.length && performance.now() < end) jobs[next++]!();
      return next >= jobs.length;
    },
  };
}

/** Frees the blob URLs and the asset source (leaving play does it; a page reload would too). */
export function releaseClips(set: ClipSet): void {
  const w = globalThis as unknown as Record<string, AssetSource | undefined>;
  const source = w[SOURCE_KEY];
  if (!source) return;
  for (const p of [...set.hits, ...set.beds]) {
    try {
      URL.revokeObjectURL(source.get(p) as string);
    } catch {
      /* already gone */
    }
  }
  Assets.removeSource(source);
  w[SOURCE_KEY] = undefined;
}
