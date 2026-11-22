/**
 * The offline render of a sample (ADR 0328 "Baked effects are rendered offline", "Flatten"): what the sample sounds like,
 * as PCM, from its source PCM and its edits, in this order:
 *
 * 1. **The edit** (`sampleEditPlan`): the trim, less the closed gaps (removed; what follows moves up), the deleted
 *    snippets silent in place. Razor cuts alone change nothing.
 * 2. **The baked chain** (ADR 0331 level "sample"), each enabled effect in order, by the same Rust kernels the buses and
 *    submixes run (`myco_audio_offline.wasm`), with its automation lanes (`fx:<id>:<param>` over source seconds, read
 *    as the engine's curves are) and the tails a delay or reverb leaves (run until they fall below −90 dBFS, at most
 *    `TAIL_CAP_SECONDS` past the end). Reverse, fades and noise reduction are offline-only kinds; `envelope` (a voice
 *    effect) renders as an ADSR over the sample, its release ending at the end. Every type the chain holds renders, even
 *    one the catalogue doesn't list at the sample level (the Studio flags it): baked, it costs nothing at runtime.
 * 3. **Normalisation** (`normalize.gainDb`, after the effects, as ADR 0328 says).
 *
 * The result starts at the trim's start; `renderTimeMap` (`sampleTimeMap.ts`) places source seconds in it. Loops and
 * the `source` field don't take part: the render is the audio a flattened sample plays (`sample.source`).
 *
 * Works in the browser and in Node (the wasm loads on first use). Not pure (it loads a module), but it reads nothing
 * else: no plugin, no DOM.
 */
import { effectSpec } from "../effects/catalogue";
import { EFFECT_TYPES } from "../effects/types";
import { curveKeyHandles, curveKeyInterpCode } from "../../core/curve";
import { renderOffline } from "./offlineWasm";
import { sampleEditPlan } from "./sampleTimeMap";
import type { SampleEdits } from "./types";

/** Interleaved PCM: int16 (scaled by 1/32768) or float. */
export interface SamplePcm {
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
}

export interface RenderedSample {
  /** Interleaved float PCM, `frames × channels`. */
  readonly pcm: Float32Array;
  readonly channels: number;
  readonly rate: number;
  readonly frames: number;
  /** One line per thing the render couldn't do as asked. */
  readonly warnings: readonly string[];
}

/** The longest tail a render keeps past the sample's end, seconds. */
export const TAIL_CAP_SECONDS = 10;

/** The kernels' parameters per effect (`audio_dsp::fx::PARAMS`). */
const PARAMS = 8;
const SPEC_VERSION = 1;

/** The edited PCM (step 1) as float, and the time segments for the render's automation. */
function cut(input: SamplePcm, edits: SampleEdits): { pcm: Float32Array; segments: number[] } {
  const ch = Math.max(1, input.channels);
  const frames = Math.floor(input.pcm.length / ch);
  const rate = input.rate;
  const scale = input.pcm instanceof Int16Array ? 1 / 32768 : 1;
  const plan = sampleEditPlan(edits, frames / rate);
  const frame = (t: number) => Math.min(frames, Math.max(0, Math.round(t * rate)));
  const spans = plan.pieces.map((p) => [frame(p.srcStart), frame(p.srcEnd)] as const);
  const total = spans.reduce((n, [s, e]) => n + Math.max(0, e - s), 0);
  const out = new Float32Array(total * ch);
  const silent = plan.silent.map(([s, e]) => [frame(s), frame(e)] as const);
  const segments: number[] = [];
  let at = 0;
  spans.forEach(([s, e], i) => {
    if (e <= s) return;
    segments.push(at, plan.pieces[i].srcStart);
    for (let f = s; f < e; f++) {
      const quiet = silent.some(([a, b]) => f >= a && f < b);
      const o = (at + f - s) * ch;
      if (!quiet) for (let c = 0; c < ch; c++) out[o + c] = input.pcm[f * ch + c] * scale;
    }
    at += e - s;
  });
  return { pcm: out, segments };
}

/** The render spec (`native/audio/crates/audio-offline/src/spec.rs`) for `edits`' chain and lanes. */
function specOf(edits: SampleEdits, segments: number[], warnings: string[]): Float64Array {
  const effects: number[] = [];
  edits.effects.forEach((f) => {
    const p = new Array<number>(PARAMS).fill(0);
    effectSpec(f.type).params.slice(0, PARAMS).forEach((q, i) => {
      const v = f.params[q.name];
      p[i] = typeof v === "number" && Number.isFinite(v) ? v : q.default;
    });
    effects.push(EFFECT_TYPES.indexOf(f.type), f.on ? 1 : 0, ...p);
  });
  const lanes: number[] = [];
  let laneCount = 0;
  for (const lane of edits.automation) {
    if (lane.bypass) continue;
    const [, id, name] = lane.target.split(":");
    const index = edits.effects.findIndex((f) => f.id === id);
    const effect = edits.effects[index];
    const param = effect ? effectSpec(effect.type).params.findIndex((q) => q.name === name) : -1;
    if (!effect || param < 0 || param >= PARAMS) {
      warnings.push(`Automation ${lane.target}: no such effect parameter in the chain; not rendered.`);
      continue;
    }
    const q = effectSpec(effect.type).params[param];
    lanes.push(index, param, q.min, q.max, lane.curve.length);
    for (const k of lane.curve) {
      const h = curveKeyHandles(k);
      lanes.push(k[0], k[1], curveKeyInterpCode(k), h ? h.in[0] : 0, h ? h.in[1] : 0, h ? h.out[0] : 0, h ? h.out[1] : 0);
    }
    laneCount++;
  }
  return new Float64Array([SPEC_VERSION, edits.effects.length, laneCount, segments.length / 2, TAIL_CAP_SECONDS].concat(effects, segments, lanes));
}

/** The render's warning bits (`render::warn` in the crate) as lines. */
function warningLines(bits: number): string[] {
  const out: string[] = [];
  if (bits & 1) out.push("An effect type this build doesn't know was left out of the render.");
  if (bits & 2) out.push(`A tail was still sounding ${TAIL_CAP_SECONDS} s after the end and was cut there.`);
  if (bits & 4) out.push("Noise reduction needs at least a few hundredths of a second of audio; the sample is too short, so it was left as it was.");
  return out;
}

/** What `edits` make of `input` (see the file header). */
export async function renderSample(input: SamplePcm, edits: SampleEdits): Promise<RenderedSample> {
  const channels = Math.max(1, input.channels);
  const { pcm, segments } = cut(input, edits);
  const warnings: string[] = [];
  const spec = specOf(edits, segments, warnings);
  const raw = await renderOffline(pcm, channels, input.rate, spec);
  warnings.push(...warningLines(raw.warnings));
  const gain = edits.normalize.mode === "off" ? 1 : Math.pow(10, edits.normalize.gainDb / 20);
  if (gain !== 1) for (let i = 0; i < raw.pcm.length; i++) raw.pcm[i] *= gain;
  return { pcm: raw.pcm, channels, rate: input.rate, frames: raw.frames, warnings };
}
