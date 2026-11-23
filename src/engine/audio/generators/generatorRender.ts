/**
 * Internal (ADR 0360 §6, §8): a generator rendered to mono float PCM through the offline module
 * (`myco_offline_generate`, offline ABI 1.2), which runs the same `audio_dsp::gen` kernels as the core's generator voice
 * and, at pitch 1 with no lanes, gives the same samples bit for bit. Bake (`bake.ts`), the Babylon fallback's
 * render-and-cache path and the Studio's waveform preview call it.
 *
 * - **`renderGenerator(body, draw)`** resolves the patch for one trigger as the runtime does (`resolveGenerator`: the
 *   noise seed drawn when `seed` is null, then `vary`, then a silence's length, in that order from `draw`), then renders
 *   it. **`renderResolvedGenerator`** renders values already resolved (a `PlayRequest.generator`).
 * - **How long.** A finite generator renders to its end: an oscillator or synth keyed off at its `length` then through
 *   its release, a blip to the end of its sfxr envelope, a silence its `length` of zeros (the module stops where the
 *   voice ended). An **endless** one (an oscillator or synth with `length` 0) renders `seconds` (default 2 s) and, with
 *   `loop`, becomes a seamless loop crossfaded over 50 ms: `"buffer"` loops the whole render (the crossfade folded into
 *   its first 50 ms: what the fallback plays), `"region"` keeps the start and loops `[50 ms, seconds + 50 ms)` with the
 *   crossfade over its last 50 ms (what a bake writes, so the attack plays once).
 * - **Lanes**: `gen:` curves over voice seconds by parameter name (a log parameter's curve read in log2, as the core's
 *   AUTOMATE target 5), and `pitch` (a ratio) — the offline module reads them as the core does.
 *
 * Works in the browser and in Node (the wasm loads on first use). No plugin, no DOM.
 */
import { curveKeyHandles, curveKeyInterpCode, type Curve } from "../../core/curve";
import { log2Curve } from "../project/fxAutomation";
import { generateOffline } from "../sample/offlineWasm";
import { generatorIsEndless, generatorKindIndex, generatorParamIndex, generatorSpec } from "./catalogue";
import { mulberry32, type Draw } from "./random";
import { resolveGenerator, type ResolvedGenerator } from "./resolve";
import type { GeneratorBody, GeneratorKind } from "./types";

/** The rate bakes and fallback renders use unless told otherwise (owner decision 8: 48 kHz). */
export const GENERATOR_RENDER_RATE = 48_000;
/** An endless generator's render, seconds (ADR 0360 §8). */
export const ENDLESS_RENDER_SECONDS = 2;
/** The loop crossfade of an endless render, seconds. */
export const LOOP_CROSSFADE_SECONDS = 0.05;
/** The longest render, seconds (a 60 s length plus a 10 s release). */
export const MAX_RENDER_SECONDS = 72;

/** sfxr's control rate (`audio_dsp::gen::blip::SFXR_RATE`). */
const SFXR_RATE = 44_100;
/** The core's quantum: the module renders in quanta, so a cap rounds up to one. */
const QUANTUM = 128;
/** The generate spec's version (`generate.rs`). */
const GENERATE_SPEC_VERSION = 1;

/** A curve over voice seconds on a parameter (by its catalogue name) or on `pitch` (a ratio). */
export interface GeneratorLane {
  readonly target: string;
  readonly curve: Curve;
}

export interface GeneratorRenderOptions {
  /** Hz; default `GENERATOR_RENDER_RATE`. */
  readonly rate?: number;
  /** An endless generator's length (default `ENDLESS_RENDER_SECONDS`); a cap on a finite one. */
  readonly seconds?: number;
  /** An endless render loops (see the file note); ignored for a finite one. Default: none (a plain render). */
  readonly loop?: "buffer" | "region";
  /** A pitch ratio over every frequency (default 1). */
  readonly pitch?: number;
  readonly lanes?: readonly GeneratorLane[];
}

export interface RenderedGenerator {
  /** Mono float PCM. */
  readonly pcm: Float32Array;
  readonly rate: number;
  readonly frames: number;
  readonly kind: GeneratorKind;
  /** The values rendered, in wire order. */
  readonly values: readonly number[];
  readonly seed: number;
  /** It sounds until released (rendered for `seconds`). */
  readonly endless: boolean;
  /** The loop region in frames when the render loops (`[0, frames)` for a `"buffer"` loop), else null. */
  readonly loop: { readonly start: number; readonly end: number } | null;
  /** One line per lane the render couldn't follow. */
  readonly warnings: readonly string[];
}

const valueOf = (kind: GeneratorKind, values: readonly number[], name: string): number => {
  const i = generatorParamIndex(kind, name);
  return i >= 0 ? (values[i] ?? 0) : 0;
};

/**
 * The seconds a finite generator lasts at most (the module stops at its real end): a blip its sfxr envelope, an
 * oscillator or synth its `length` plus twice its release (the release falls to −60 dB at 1.5×), a silence its `length`.
 */
function finiteSeconds(kind: GeneratorKind, values: readonly number[]): number {
  switch (kind) {
    case "blip": {
      const ticks = (p: number): number => Math.floor(Math.fround(Math.fround(p * p) * 100_000));
      return (ticks(valueOf(kind, values, "attack")) + ticks(valueOf(kind, values, "sustain")) + ticks(valueOf(kind, values, "decay")) + 3) / SFXR_RATE;
    }
    case "silence":
      return valueOf(kind, values, "length");
    default:
      return valueOf(kind, values, "length") + (2 * valueOf(kind, values, "release")) / 1000 + 0.01;
  }
}

/** The generate spec (`native/audio/crates/audio-offline/src/generate.rs`) for `pitch` and `lanes`. */
function specOf(kind: GeneratorKind, pitch: number, lanes: readonly GeneratorLane[], warnings: string[]): Float64Array {
  if (pitch === 1 && lanes.length === 0) return new Float64Array(0);
  const params = generatorSpec(kind).params;
  const out: number[] = [];
  let count = 0;
  for (const lane of lanes) {
    if (lane.curve.length === 0) continue;
    let target: number, min: number, max: number, log = false, curve = lane.curve;
    if (lane.target === "pitch") {
      [target, min, max] = [-1, 1 / 16, 16];
    } else {
      target = generatorParamIndex(kind, lane.target);
      const q = params[target];
      if (!q) {
        warnings.push(`The ${kind} generator has no parameter "${lane.target}"; its lane wasn't rendered.`);
        continue;
      }
      [min, max] = [q.min, q.max];
      if (q.scale === "log" && q.min > 0) {
        log = true;
        curve = log2Curve(curve.map((k) => (k[1] >= q.min ? k : ([k[0], q.min, ...k.slice(2)] as unknown as typeof k))));
      }
    }
    out.push(target, min, max, log ? 1 : 0, curve.length);
    for (const k of curve) {
      const h = curveKeyHandles(k);
      out.push(k[0], k[1], curveKeyInterpCode(k), h ? h.in[0] : 0, h ? h.in[1] : 0, h ? h.out[0] : 0, h ? h.out[1] : 0);
    }
    count++;
  }
  return new Float64Array([GENERATE_SPEC_VERSION, pitch > 0 && Number.isFinite(pitch) ? pitch : 1, count, ...out]);
}

/**
 * `render` (at least `n + x` frames) as a loop of `n` frames with an `x`-frame linear crossfade: `"buffer"` folds the
 * continuation past `n` into the first `x` frames (loop the whole result); `"region"` keeps the start and folds the
 * render's first `x` frames into its last `x` (loop `[x, n + x)`).
 */
function crossfadeLoop(render: Float32Array, n: number, x: number, mode: "buffer" | "region"): Float32Array {
  if (mode === "buffer") {
    const out = render.slice(0, n);
    for (let i = 0; i < x; i++) {
      const u = i / x;
      out[i] = render[i]! * u + render[n + i]! * (1 - u);
    }
    return out;
  }
  const out = render.slice(0, n + x);
  for (let i = 0; i < x; i++) {
    const u = (i + 1) / x;
    out[n + i] = render[n + i]! * (1 - u) + render[i]! * u;
  }
  return out;
}

/** Renders values already resolved for one trigger (see the file note). */
export async function renderResolvedGenerator(resolved: ResolvedGenerator, options: GeneratorRenderOptions = {}): Promise<RenderedGenerator> {
  const { kind, values, seed } = resolved;
  const rate = options.rate && options.rate > 0 ? options.rate : GENERATOR_RENDER_RATE;
  const pitch = options.pitch ?? 1;
  const warnings: string[] = [];
  const params = Object.fromEntries(generatorSpec(kind).params.map((q, i) => [q.name, values[i] ?? q.default]));
  const endless = generatorIsEndless(kind, params);
  const asked = options.seconds !== undefined && options.seconds > 0 ? Math.min(MAX_RENDER_SECONDS, options.seconds) : null;
  const spec = specOf(kind, pitch, options.lanes ?? [], warnings);
  const kindIndex = generatorKindIndex(kind);
  if (endless) {
    const n = Math.max(1, Math.round((asked ?? ENDLESS_RENDER_SECONDS) * rate));
    const x = options.loop ? Math.min(Math.floor(n / 2), Math.round(LOOP_CROSSFADE_SECONDS * rate)) : 0;
    const raw = await generateOffline(kindIndex, values, seed, rate, n + x, spec);
    if (!options.loop || x === 0 || raw.frames < n + x) return { pcm: raw.pcm.slice(0, n), rate, frames: Math.min(n, raw.frames), kind, values, seed, endless, loop: null, warnings };
    const pcm = crossfadeLoop(raw.pcm, n, x, options.loop);
    const loop = options.loop === "buffer" ? { start: 0, end: n } : { start: x, end: n + x };
    return { pcm, rate, frames: pcm.length, kind, values, seed, endless, loop, warnings };
  }
  // A finite generator: to its end (the module trims there), capped. Slower pitches last no longer: a generator's
  // envelopes keep their times, so the cap needs no pitch term.
  const seconds = Math.min(asked ?? MAX_RENDER_SECONDS, finiteSeconds(kind, values));
  const frames = Math.ceil((seconds * rate) / QUANTUM + 1) * QUANTUM;
  const raw = await generateOffline(kindIndex, values, seed, rate, frames, spec);
  return { pcm: raw.pcm, rate, frames: raw.frames, kind, values, seed, endless, loop: null, warnings };
}

/**
 * Renders `body` for one trigger: its patch resolved from `draw` exactly as the runtime resolves it (default: a fixed
 * mulberry32 stream, so a preview renders the same every time).
 */
export function renderGenerator(body: GeneratorBody, draw: Draw = mulberry32(0), options: GeneratorRenderOptions = {}): Promise<RenderedGenerator> {
  return renderResolvedGenerator(resolveGenerator(body, draw), options);
}
