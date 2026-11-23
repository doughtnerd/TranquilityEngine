/**
 * A generator voice's plan at runtime (ADR 0360 §3–§5, G3): what a trigger of a generator entry or a sequence generator
 * clip sends, read from the generator catalogue generically (a parameter appended to a kind needs nothing here).
 *
 * - **`resolveGeneratorPlay`**: the patch resolved for one trigger (`resolveGenerator`: the noise seed when `seed` is
 *   null, `vary`, a silence's length, drawn from the World's seeded generator in that order), then a sequence clip's
 *   key-off folded into the kind's `length` (the core keys off sample-exactly at its `length`), and how it ends: whether
 *   it sounds until released (an oscillator or synth with no length, or the PLAY loop flag) and its length in seconds
 *   when known (a blip by sfxr's envelope, an oscillator or synth by its length and release, a silence by its length).
 * - **`generatorBindings`**: `gen:<param>` curves as AUTOMATE target-5 bindings (`generatorTarget`): a log parameter's
 *   curve in log2 of its values (the core reads 2^y), a choice's keys as they are (the lint asks for step keys); time
 *   curves read the voice's time (a generator has no clip playhead: clip time is voice time) or the sequence clock.
 */
import type { Curve, CurveKey } from "../../../../engine/core/curve";
import { generatorParamIndex, generatorSpec, generatorWireValues } from "../../../../engine/audio/generators/catalogue";
import { resolveGenerator } from "../../../../engine/audio/generators/resolve";
import type { Draw } from "../../../../engine/audio/generators/random";
import type { GeneratorBody, GeneratorKind } from "../../../../engine/audio/generators/types";
import { log2Curve } from "../../../../engine/audio/project/fxAutomation";
import { MAX_BINDINGS, TimeParam, timeParam, type AutoTarget, type Binding, type ParamRef } from "../automation";
import type { GeneratorSource } from "../backend";
import { generatorTarget } from "../core/commandWriter";
import { warnOnce } from "../core/handle";
import type { GenCurve } from "./liveNode";

/** sfxr's control rate: its envelope counts ticks of 1/44,100 s (`audio_dsp::gen::blip::SFXR_RATE`). */
const SFXR_RATE = 44_100;

/** One trigger's generator: what the request carries and how the voice ends. */
export interface GeneratorPlan {
  readonly source: GeneratorSource;
  /** It sounds until released or stopped: an oscillator or synth whose `length` is 0. */
  readonly endless: boolean;
  /** Seconds from its start to its end when it isn't endless (before any loop flag), else null. */
  readonly seconds: number | null;
}

/**
 * The generator `body` plays for one trigger, drawing from `draw` (the World's generator, so takes replay it).
 * `keyOffAfter` (seconds; a sequence clip's remaining length) replaces the `length` of a kind that has one.
 */
export function resolveGeneratorPlay(body: GeneratorBody, draw: Draw, keyOffAfter?: number): GeneratorPlan {
  const r = resolveGenerator(body, draw);
  const values = r.values;
  const li = generatorParamIndex(r.kind, "length");
  if (li >= 0 && keyOffAfter !== undefined && Number.isFinite(keyOffAfter) && keyOffAfter > 0) {
    const q = generatorSpec(r.kind).params[li]!;
    // A silence ends at its own length or the clip's end, whichever is first; a tone keys off at the clip's end.
    const until = Math.min(q.max, Math.max(q.min, keyOffAfter));
    values[li] = r.kind === "silence" ? Math.min(values[li]!, until) : until;
  }
  const endless = (r.kind === "oscillator" || r.kind === "synth") && li >= 0 && !(values[li]! > 0);
  return { source: { kind: r.kind, values, seed: r.seed }, endless, seconds: endless ? null : generatorSeconds(r.kind, values) };
}

/** The value of parameter `name` of `kind` in wire-order `values` (`fallback` when the kind has none). */
function valueOf(kind: GeneratorKind, values: readonly number[], name: string, fallback = 0): number {
  const i = generatorParamIndex(kind, name);
  return i >= 0 ? (values[i] ?? fallback) : fallback;
}

/**
 * Seconds a generator of `kind` with wire-order `values` lasts from its start (no loop flag): a blip its sfxr envelope
 * (attack, sustain and decay of `p² × 100,000` ticks each, plus a tick a stage, at 44.1 kHz, in the core's f32), an
 * oscillator or synth its `length` plus its amp release, a silence its `length`.
 */
export function generatorSeconds(kind: GeneratorKind, values: readonly number[]): number {
  switch (kind) {
    case "blip": {
      const ticks = (p: number): number => Math.floor(Math.fround(Math.fround(p * p) * 100_000));
      return (ticks(valueOf(kind, values, "attack")) + ticks(valueOf(kind, values, "sustain")) + ticks(valueOf(kind, values, "decay")) + 3) / SFXR_RATE;
    }
    case "silence":
      return valueOf(kind, values, "length");
    default:
      return valueOf(kind, values, "length") + valueOf(kind, values, "release") / 1000;
  }
}

/**
 * ADR 0360 §5 (hot reload): the parameters (by catalogue index, wire order) whose stored values differ between two
 * patches of one kind, with `next`'s values. `vary`, the seed and a silence's length draw aren't re-applied.
 */
export function changedGeneratorParams(before: GeneratorBody, next: GeneratorBody): Map<number, number> {
  const a = generatorWireValues(before.kind, before.params);
  const b = generatorWireValues(next.kind, next.params);
  const out = new Map<number, number>();
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.set(i, b[i]!);
  return out;
}

/** A curve input's time parameter for a generator voice (clip time is its voice time: a generator has no clip). */
const TIME_INPUTS = { voiceTime: TimeParam.Voice, clipTime: TimeParam.Voice, sequenceTime: TimeParam.Sequence } as const;

/**
 * `curves` (`gen:<param>`) as target-5 bindings for a generator of `kind`, after `bindings` (at most `MAX_BINDINGS` in
 * all). `paramRef` resolves a parameter name (null: unknown, already warned); `curveId` gives a curve's id (null: full).
 * A parameter the kind doesn't have is skipped with one warning (the lint's `genTargetUnknown`).
 */
export function generatorBindings(
  kind: GeneratorKind,
  curves: readonly GenCurve[],
  bindings: readonly Binding[],
  paramRef: (name: string) => ParamRef | null,
  curveId: (curve: Curve) => number | null,
  where: string,
): readonly Binding[] {
  if (curves.length === 0) return bindings;
  let out = bindings;
  const params = generatorSpec(kind).params;
  for (const c of curves) {
    const index = generatorParamIndex(kind, c.param);
    if (index < 0) {
      warnOnce(`playlist:gen-unknown:${where}:${kind}:${c.param}`, `[myco] ${where}: a ${kind} generator has no parameter "${c.param}"; its gen:${c.param} curve is skipped.`);
      continue;
    }
    if (c.quantize !== undefined) warnOnce(`playlist:gen-quantize:${where}:${c.param}`, `[myco] ${where}: quantize on the gen:${c.param} curve isn't followed for generators yet; it moves continuously.`);
    const p = typeof c.input === "string" ? timeParam(TIME_INPUTS[c.input] ?? TimeParam.Voice) : paramRef(c.input.parameter);
    if (!p) continue;
    const q = params[index]!;
    const log = q.scale === "log" && q.min > 0;
    const id = curveId(log ? log2Curve(clampKeys(c.curve, q.min)) : c.curve);
    if (id === null) continue;
    if (out.length >= MAX_BINDINGS) {
      warnOnce(`playlist:bindings:${where}`, `[myco] ${where}: more than ${MAX_BINDINGS} parameter and time curves reach one voice; the rest are ignored.`);
      break;
    }
    const offset = c.offset !== undefined && c.offset !== 0 && Number.isFinite(c.offset) && typeof c.input === "string" ? { offset: c.offset } : {};
    out = [...out, { param: p, curve: id, target: generatorTarget(index, log) as AutoTarget, ...offset }];
  }
  return out;
}

/** A log parameter's curve with every value at least `min` (> 0), so its log2 is finite. */
function clampKeys(curve: Curve, min: number): Curve {
  return curve.some((k) => !(k[1] >= min)) ? curve.map((k) => [k[0], Math.max(min, Number.isFinite(k[1]) ? k[1] : min), ...k.slice(2)] as unknown as CurveKey) : curve;
}
