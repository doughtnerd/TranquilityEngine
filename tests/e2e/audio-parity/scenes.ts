// The Web Audio parity scenes (ADR 0157, api-and-models §8 "Web Audio parity"; task A2.2c).
//
// A scene is pure data: generated source clips, a bus tree with effects, and voices. The same scene is rendered
// twice, by the core (`coreRender.ts`, the committed wasm in Node) and by an `OfflineAudioContext` running the
// reference graph (`browserRender.ts`, in Chromium), and the two are compared (`analysis.ts`). Nothing here touches
// the platform: the clips are computed from seeds in plain TypeScript, so Node and the browser start from the same
// samples (the spec ships them to the page as bytes).
//
// Conventions every scene shares:
// - Voices play on a child bus ("Bus") of the root ("Master"); the root and MASTER stay at unity, so the reverb
//   return (the core adds it before MASTER, the reference sends it straight to the destination) cannot differ.
// - Every clip is the context's rate, at pitch 1: the resampler is the identity, so clip samples reach the bus as is.
// - Both renders start with `prerollFrames(scene)` frames of silence (the core needs quanta to copy its clips into
//   the arena before the PLAY), then the voices start together; the pre-roll is trimmed from both outputs.
import type { BusEffect } from "../../../src/engine/audio/settings";
import type { ResolvedBus } from "../../../src/engine/audio/mixer";

export type ParityRate = 44_100 | 48_000;

/** A generated source clip. `db` is the clip's RMS in dBFS; noise is uniform white from a mulberry32 seed. */
export type ClipSpec =
  | { kind: "noise"; seed: number; db: number; seconds: number; channels?: 1 | 2 }
  | { kind: "sine"; hz: number; db: number; seconds: number }
  /** A sine at `db` RMS with the level changing at the given times: `[[seconds, db], ...]` from time 0. */
  | { kind: "steps"; hz: number; seconds: number; steps: readonly (readonly [number, number])[] }
  /** Noise bursts: `on` seconds of noise at `dbOn`, then `off` seconds at `dbOff`, repeating. */
  | { kind: "bursts"; seed: number; seconds: number; on: number; off: number; dbOn: number; dbOff: number }
  /** One impulse of `amplitude` at `frame`, silence elsewhere. */
  | { kind: "click"; frame: number; amplitude: number; seconds: number };

export interface SceneVoice {
  clip: number;
  /** `"Bus"` (the child bus) or `"Master"`. */
  bus: "Bus" | "Master";
  gain?: number;
  /**
   * Listener-space direction (+X right, -Z ahead, as Web Audio's default listener), at distance 1 so a
   * `PannerNode`'s default distance model gives gain 1. Absent: a non-spatial voice (identity pan).
   * `panner: "hrtf"` (H4, `hrtfScenes.ts`): the reference builds a `PannerNode` with `panningModel: "HRTF"`; the core
   * renders the voice with the HRIR table loaded and the PLAY's panner bits set to HRTF (`coreRender.ts`).
   */
  spatial?: { dir: readonly [number, number, number]; panner?: "equalpower" | "hrtf" };
}

/** How strictly a scene is compared (see `TOLERANCES` in `analysis.ts`). */
export type Profile = "biquad" | "compressor" | "reverb" | "pan" | "hrtf";

export interface Scene {
  id: string;
  group: "filter" | "snapshot" | "compressor" | "reverb" | "pan" | "hrtf";
  profile: Profile;
  rate: ParityRate;
  /** Rendered length after the pre-roll, in seconds. */
  seconds: number;
  clips: readonly ClipSpec[];
  /** Effects on "Bus" (the child bus), in order. */
  effects: readonly BusEffect[];
  /** Bus gains (default 1). */
  busGain?: number;
  /** A snapshot's low-pass on "Bus" (Hz). */
  snapshotLowpass?: number;
  voices: readonly SceneVoice[];
  /** Analyse (bands) from this time on, past the start-up transient. */
  analyzeFrom: number;
  /** Keep sample windows in the committed digest (the Node test's sample-level check). */
  windows: boolean;
  /** Compare the largest sample's position (a click's: the compressor's pre-delay); for tones and noise it is arbitrary. */
  peakPosition?: boolean;
  /**
   * Frames the reference lags the core by (the HRTF panner's convolver latency, 256 frames in Chromium): the reference
   * renders that many extra frames and drops the first, so the two outputs line up (`hrtfScenes.ts`). Default 0.
   */
  referenceLatency?: number;
  /** Reverb scenes also digest the energy decay curve from this time (seconds). */
  edcFrom?: number;
}

// --- Seeded generators -----------------------------------------------------------------------------------------------

/** mulberry32: the same generator the core's reverb IR uses (its seed and `Math.imul` form). */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const dbToLin = (db: number): number => Math.pow(10, db / 20);

/** Uniform white noise with the given RMS (a uniform ±a has RMS a/√3). */
function noise(rand: () => number, frames: number, db: number): Float32Array {
  const a = dbToLin(db) * Math.sqrt(3);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = (rand() * 2 - 1) * a;
  return out;
}

/** The clip's channels (planar), at `rate`. */
export function makeClip(spec: ClipSpec, rate: number): Float32Array[] {
  const frames = Math.round(spec.seconds * rate);
  switch (spec.kind) {
    case "noise": {
      const rand = mulberry32(spec.seed);
      const left = noise(rand, frames, spec.db);
      return spec.channels === 2 ? [left, noise(rand, frames, spec.db)] : [left];
    }
    case "sine": {
      const out = new Float32Array(frames);
      const a = dbToLin(spec.db) * Math.SQRT2;
      for (let i = 0; i < frames; i++) out[i] = a * Math.sin((2 * Math.PI * spec.hz * i) / rate);
      return [out];
    }
    case "steps": {
      const out = new Float32Array(frames);
      let db = spec.steps[0]![1];
      let next = 1;
      for (let i = 0; i < frames; i++) {
        while (next < spec.steps.length && i >= spec.steps[next]![0] * rate) db = spec.steps[next++]![1];
        out[i] = dbToLin(db) * Math.SQRT2 * Math.sin((2 * Math.PI * spec.hz * i) / rate);
      }
      return [out];
    }
    case "bursts": {
      const rand = mulberry32(spec.seed);
      const out = new Float32Array(frames);
      const period = (spec.on + spec.off) * rate;
      for (let i = 0; i < frames; i++) {
        const on = i % period < spec.on * rate;
        out[i] = (rand() * 2 - 1) * dbToLin(on ? spec.dbOn : spec.dbOff) * Math.sqrt(3);
      }
      return [out];
    }
    case "click": {
      const out = new Float32Array(frames);
      out[spec.frame] = spec.amplitude;
      return [out];
    }
  }
}

// --- Timing shared by both renders -----------------------------------------------------------------------------------

export const QUANTUM = 128;
/** The core copies at most 256 KB of clip per quantum (`CLIP_BYTES_PER_QUANTUM`). */
const CLIP_BYTES_PER_QUANTUM = 256 * 1024;

/** Silent frames before the voices start: enough quanta for the core to copy every clip, plus one. */
export function prerollFrames(scene: Scene): number {
  let bytes = 0;
  for (const c of scene.clips) bytes += Math.round(c.seconds * scene.rate) * ("channels" in c && c.channels === 2 ? 2 : 1) * 4;
  return (Math.ceil(bytes / CLIP_BYTES_PER_QUANTUM) + 2) * QUANTUM;
}

/** Frames rendered after the pre-roll. */
export const sceneFrames = (scene: Scene): number => Math.round(scene.seconds * scene.rate);

/** The two buses of every scene as the mixer resolves them: the root, and "Bus" under it with the scene's effects, gain and snapshot low-pass. */
export function sceneBuses(scene: Scene): ResolvedBus[] {
  const gain = scene.busGain ?? 1;
  return [
    { name: "Master", parent: null, gain: 1, effectiveGain: 1, effects: [], snapshotLowpass: null },
    { name: "Bus", parent: "Master", gain, effectiveGain: gain, effects: [...scene.effects], snapshotLowpass: scene.snapshotLowpass ?? null },
  ];
}

// --- The catalogue ---------------------------------------------------------------------------------------------------

const WHITE = (seed: number, seconds: number, db = -12): ClipSpec => ({ kind: "noise", seed, db, seconds });

function filterScene(type: "lowpass" | "highpass", frequency: number, q: number, rate: ParityRate, windows: boolean): Scene {
  return {
    id: `${type === "lowpass" ? "lp" : "hp"}-${frequency}-q${q}@${rate / 1000}`,
    group: "filter",
    profile: "biquad",
    rate,
    seconds: 1.5,
    clips: [WHITE(0x1000 + frequency + q, 1.5)],
    effects: [{ type, frequency, q }],
    voices: [{ clip: 0, bus: "Bus" }],
    analyzeFrom: 0.1,
    windows,
  };
}

/** Lowpass and highpass sweeps: frequencies across the band, Q in dB (Web Audio's unit for these two types). */
function filterScenes(): Scene[] {
  const out: Scene[] = [];
  for (const type of ["lowpass", "highpass"] as const) {
    for (const f of [200, 1000, 5000, 12_000]) for (const q of [0, 1, 6, 12]) out.push(filterScene(type, f, q, 48_000, true));
    // 44.1 kHz: the coefficients depend on the rate; a subset is enough.
    for (const f of [1000, 5000, 12_000]) for (const q of [1, 12]) out.push(filterScene(type, f, q, 44_100, false));
  }
  // A cutoff past Nyquist at 44.1 kHz (the clamp), and below the lowest the node allows (also clamped by the port).
  out.push(filterScene("lowpass", 21_000, 1, 44_100, false), filterScene("highpass", 5, 1, 48_000, false));
  return out;
}

/** The snapshot low-pass (Q = 1 dB, the mixer's `snapshotLowpass` on a bus) at both rates. */
function snapshotScenes(): Scene[] {
  const out: Scene[] = [];
  for (const rate of [48_000, 44_100] as const) {
    for (const hz of [800, 6000]) {
      out.push({
        id: `snapshot-lp-${hz}@${rate / 1000}`,
        group: "snapshot",
        profile: "biquad",
        rate,
        seconds: 1.5,
        clips: [WHITE(0x2000 + hz, 1.5)],
        effects: [],
        busGain: 0.5,
        snapshotLowpass: hz,
        voices: [{ clip: 0, bus: "Bus" }],
        analyzeFrom: 0.1,
        windows: rate === 48_000,
      });
    }
  }
  return out;
}

/** Web Audio's compressor defaults, and a harder setting with a faster attack and release. */
export const COMPRESSORS = {
  default: { type: "compressor", threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
  hard: { type: "compressor", threshold: -30, knee: 6, ratio: 4, attack: 0.01, release: 0.1 },
} as const satisfies Record<string, BusEffect>;

/** The static curve points (tone dBFS RMS), steady state after the envelope settles. */
export const CURVE_LEVELS = [-60, -48, -36, -30, -24, -18, -12, -6, -1] as const;

function compressorScenes(): Scene[] {
  const out: Scene[] = [];
  for (const [name, fx] of Object.entries(COMPRESSORS)) {
    for (const db of CURVE_LEVELS) {
      out.push({
        id: `comp-${name}-tone${db}@48`,
        group: "compressor",
        profile: "compressor",
        rate: 48_000,
        seconds: 1.5,
        clips: [{ kind: "sine", hz: 1000, db, seconds: 1.5 }],
        effects: [fx],
        voices: [{ clip: 0, bus: "Bus" }],
        analyzeFrom: 1.0,
        windows: name === "default",
      });
    }
    // The envelope: a loud step in a quiet tone, and gated noise (attack, adaptive release).
    out.push({
      id: `comp-${name}-steps@48`,
      group: "compressor",
      profile: "compressor",
      rate: 48_000,
      seconds: 2,
      clips: [{ kind: "steps", hz: 440, seconds: 2, steps: [[0, -40], [0.5, -6], [1.0, -40], [1.5, -3]] }],
      effects: [fx],
      voices: [{ clip: 0, bus: "Bus" }],
      analyzeFrom: 0,
      windows: true,
    });
    out.push({
      id: `comp-${name}-noise@48`,
      group: "compressor",
      profile: "compressor",
      rate: 48_000,
      seconds: 2.4,
      clips: [{ kind: "bursts", seed: 0x3000, seconds: 2.4, on: 0.3, off: 0.3, dbOn: -10, dbOff: -34 }],
      effects: [fx],
      voices: [{ clip: 0, bus: "Bus" }],
      analyzeFrom: 0,
      windows: true,
    });
  }
  // The 6 ms pre-delay: one click through the compressor below its threshold.
  out.push({
    id: "comp-click@48",
    group: "compressor",
    profile: "compressor",
    rate: 48_000,
    seconds: 0.25,
    peakPosition: true,
    clips: [{ kind: "click", frame: 1000, amplitude: 0.05, seconds: 0.25 }],
    effects: [COMPRESSORS.default],
    voices: [{ clip: 0, bus: "Bus" }],
    analyzeFrom: 0,
    windows: false,
  });
  out.push({ ...out[out.length - 1]!, id: "comp-click@44.1", rate: 44_100 });
  // 44.1 kHz: the pre-delay line is sized for 48 kHz (A2.2a), so the rate-dependent parts are checked here.
  for (const db of [-48, -24, -6]) {
    out.push({
      id: `comp-default-tone${db}@44.1`,
      group: "compressor",
      profile: "compressor",
      rate: 44_100,
      seconds: 1.5,
      clips: [{ kind: "sine", hz: 1000, db, seconds: 1.5 }],
      effects: [COMPRESSORS.default],
      voices: [{ clip: 0, bus: "Bus" }],
      analyzeFrom: 1.0,
      windows: false,
    });
  }
  out.push({
    id: "comp-default-noise@44.1",
    group: "compressor",
    profile: "compressor",
    rate: 44_100,
    seconds: 2.4,
    clips: [{ kind: "bursts", seed: 0x3000, seconds: 2.4, on: 0.3, off: 0.3, dbOn: -10, dbOff: -34 }],
    effects: [COMPRESSORS.default],
    voices: [{ clip: 0, bus: "Bus" }],
    analyzeFrom: 0,
    windows: false,
  });
  return out;
}

function reverbScenes(): Scene[] {
  const burst: ClipSpec = { kind: "noise", seed: 0x4000, db: -6, seconds: 0.05 };
  const mk = (id: string, rate: ParityRate, send: number, wetOnly: boolean, clip: ClipSpec = burst): Scene => ({
    id,
    group: "reverb",
    profile: "reverb",
    rate,
    seconds: 2.4,
    clips: [clip],
    effects: [{ type: "reverb", send }],
    // The send taps the bus before its gain: a bus at gain 0 is the wet signal alone.
    busGain: wetOnly ? 0 : 1,
    voices: [{ clip: 0, bus: "Bus" }],
    analyzeFrom: 0,
    windows: rate === 48_000,
    edcFrom: 0.05,
  });
  return [
    mk("reverb-wet-send1@48", 48_000, 1, true),
    mk("reverb-wet-send0.3@48", 48_000, 0.3, true),
    mk("reverb-mix-send0.5@48", 48_000, 0.5, false),
    mk("reverb-wet-send1-stereo-noise@48", 48_000, 1, true, { kind: "noise", seed: 0x4100, db: -9, seconds: 0.3, channels: 2 }),
    mk("reverb-wet-send1@44.1", 44_100, 1, true),
  ];
}

/** Pan law: an equal-power spatial voice against a `PannerNode` (`equalpower`) at fixed directions. */
function panScenes(): Scene[] {
  const out: Scene[] = [];
  const dirs: [string, [number, number, number]][] = [
    ["az-90", [-1, 0, 0]],
    ["az-60", [-Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3)]],
    ["az-30", [-0.5, 0, -Math.cos(Math.PI / 6)]],
    ["az0", [0, 0, -1]],
    ["az+30", [0.5, 0, -Math.cos(Math.PI / 6)]],
    ["az+60", [Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3)]],
    ["az+90", [1, 0, 0]],
    ["back", [0.5, 0, 0.8660254037844386]],
    ["above-right", [0.6, 0.5, -0.6244997998398398]],
  ];
  for (const [name, dir] of dirs) {
    out.push({
      id: `pan-mono-${name}@48`,
      group: "pan",
      profile: "pan",
      rate: 48_000,
      seconds: 0.5,
      clips: [WHITE(0x5000, 0.5, -12)],
      effects: [],
      voices: [{ clip: 0, bus: "Bus", spatial: { dir, panner: "equalpower" } }],
      analyzeFrom: 0.05,
      windows: true,
    });
  }
  for (const [name, dir] of [dirs[1]!, dirs[5]!, dirs[7]!] as const) {
    out.push({
      id: `pan-stereo-${name}@48`,
      group: "pan",
      profile: "pan",
      rate: 48_000,
      seconds: 0.5,
      clips: [{ kind: "noise", seed: 0x5100, db: -12, seconds: 0.5, channels: 2 }],
      effects: [],
      voices: [{ clip: 0, bus: "Bus", spatial: { dir, panner: "equalpower" } }],
      analyzeFrom: 0.05,
      windows: true,
    });
  }
  out.push({
    id: "pan-mono-az+60@44.1",
    group: "pan",
    profile: "pan",
    rate: 44_100,
    seconds: 0.5,
    clips: [WHITE(0x5000, 0.5, -12)],
    effects: [],
    voices: [{ clip: 0, bus: "Bus", spatial: { dir: dirs[5]![1], panner: "equalpower" } }],
    analyzeFrom: 0.05,
    windows: false,
  });
  return out;
}

export const SCENES: readonly Scene[] = [...filterScenes(), ...snapshotScenes(), ...compressorScenes(), ...reverbScenes(), ...panScenes()];

/**
 * H4: HRTF against `PannerNode` with `panningModel: "HRTF"` at fixed directions (null tests, ITD and level checks),
 * defined in `hrtfScenes.ts` (a scene there has `spatial.panner: "hrtf"`). Kept out of `SCENES`: their digests are
 * committed in `hrtf-reference.json`, and the aligned comparison is `hrtfAnalysis.ts`'s.
 */
export { HRTF_SCENES } from "./hrtfScenes";

export const sceneById = (id: string): Scene => {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown parity scene ${id}`);
  return s;
};
