/**
 * A loop's behaviour (activation, exit, re-entry), shared by sample loops (ADR 0328), clip loop overrides and sequence
 * loops (ADR 0329): the one parse and writer of those fields.
 *
 * Pure; no plugin, no DOM.
 */
import { isRecord, LenientReader } from "../lenientRead";
import { FADE_SHAPES, type FadeShape, type LoopBehaviour } from "./types";
import { isFadeShape } from "./fadeShapes";

export const LOOP_ACTIVE = ["always", "held", "parameter"] as const satisfies readonly LoopBehaviour["active"][];
export const LOOP_EXIT = ["finish", "jump", "crossfade"] as const satisfies readonly LoopBehaviour["exit"][];
export const LOOP_REENTRY = ["ignore", "reenter"] as const satisfies readonly LoopBehaviour["reentry"][];
export const LOOP_BINDING_OPS = [">", "<"] as const;
/** Exit crossfade, ms (the prototype's 1..2000; 0 allowed for a cut). */
export const MAX_EXIT_FADE_MS = 2000;
export const DEFAULT_EXIT_FADE_MS = 40;

type Binding = NonNullable<LoopBehaviour["binding"]>;

/** A parameter binding `{ parameter, op, value }`, or undefined (with a problem) when it isn't one. */
export function parseLoopBinding(raw: unknown, where: string, problems: string[]): Binding | undefined {
  const r = new LenientReader(problems);
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || typeof raw.parameter !== "string" || raw.parameter === "") {
    r.problem(where, "a binding needs a parameter name; dropped.");
    return undefined;
  }
  return {
    parameter: raw.parameter,
    op: r.pick(raw.op, `${where}.op`, LOOP_BINDING_OPS, ">"),
    value: r.num(raw.value, `${where}.value`, 0),
  };
}

/**
 * The behaviour fields of a loop object. `defaultActive` is what a missing `active` means (a sample loop with a repeat
 * count is `always`, else `held`, as in the prototype; sequence loops are `always`).
 */
export function parseLoopBehaviour(raw: Record<string, unknown>, where: string, problems: string[], defaultActive: LoopBehaviour["active"] = "always"): LoopBehaviour {
  const r = new LenientReader(problems);
  const out: LoopBehaviour = {
    active: r.pick(raw.active, `${where}.active`, LOOP_ACTIVE, defaultActive),
    exit: r.pick(raw.exit, `${where}.exit`, LOOP_EXIT, "finish"),
    exitFadeMs: r.num(raw.exitFadeMs, `${where}.exitFadeMs`, DEFAULT_EXIT_FADE_MS, 0, MAX_EXIT_FADE_MS),
    reentry: r.pick(raw.reentry, `${where}.reentry`, LOOP_REENTRY, "ignore"),
  };
  const binding = parseLoopBinding(raw.binding, `${where}.binding`, problems);
  if (binding) out.binding = binding;
  readShapes(raw, where, r, out);
  return out;
}

/** ADR 0336: a loop's crossfade shapes, when set and not the default (a bad name: one problem, the default). */
function readShapes(raw: Record<string, unknown>, where: string, r: LenientReader, out: Partial<LoopBehaviour>): void {
  for (const k of ["crossfadeShape", "exitShape"] as const) {
    if (raw[k] === undefined) continue;
    const v = raw[k];
    if (!isFadeShape(v)) {
      r.problem(`${where}.${k}`, `must be one of ${FADE_SHAPES.join(", ")}; using equalPower.`);
      continue;
    }
    if (v !== "equalPower") out[k] = v as FadeShape;
  }
}

/** The shapes as JSON (only those set and not the default). */
function writeShapes(b: Partial<LoopBehaviour>, out: Record<string, unknown>): void {
  if (b.crossfadeShape && b.crossfadeShape !== "equalPower") out.crossfadeShape = b.crossfadeShape;
  if (b.exitShape && b.exitShape !== "equalPower") out.exitShape = b.exitShape;
}

/** The behaviour fields as JSON, in a stable order (every field written, `binding` and shapes when set). */
export function loopBehaviourToJson(b: LoopBehaviour): Record<string, unknown> {
  const out: Record<string, unknown> = { active: b.active };
  if (b.binding) out.binding = { parameter: b.binding.parameter, op: b.binding.op, value: b.binding.value };
  out.exit = b.exit;
  out.exitFadeMs = b.exitFadeMs;
  out.reentry = b.reentry;
  writeShapes(b, out);
  return out;
}

/** A clip's override of one loop: any behaviour field, plus `start`/`end` (seconds in the sample). */
export type LoopOverride = Partial<LoopBehaviour> & { start?: number; end?: number };

/** A partial override, leniently: only the fields present are read. */
export function parseLoopOverride(raw: unknown, where: string, problems: string[]): LoopOverride | null {
  const r = new LenientReader(problems);
  if (!isRecord(raw)) {
    r.problem(where, "a loop override must be an object; dropped.");
    return null;
  }
  const out: LoopOverride = {};
  if (raw.active !== undefined) out.active = r.pick(raw.active, `${where}.active`, LOOP_ACTIVE, "always");
  if (raw.binding !== undefined) {
    const b = parseLoopBinding(raw.binding, `${where}.binding`, problems);
    if (b) out.binding = b;
  }
  if (raw.exit !== undefined) out.exit = r.pick(raw.exit, `${where}.exit`, LOOP_EXIT, "finish");
  if (raw.exitFadeMs !== undefined) out.exitFadeMs = r.num(raw.exitFadeMs, `${where}.exitFadeMs`, DEFAULT_EXIT_FADE_MS, 0, MAX_EXIT_FADE_MS);
  if (raw.reentry !== undefined) out.reentry = r.pick(raw.reentry, `${where}.reentry`, LOOP_REENTRY, "ignore");
  if (raw.start !== undefined) out.start = r.num(raw.start, `${where}.start`, 0, 0);
  if (raw.end !== undefined) out.end = r.num(raw.end, `${where}.end`, 0, 0);
  if (out.start !== undefined && out.end !== undefined && out.end < out.start) {
    r.problem(where, "end was before start; swapped.");
    [out.start, out.end] = [out.end, out.start];
  }
  readShapes(raw, where, r, out);
  for (const k of Object.keys(raw)) {
    if (!["active", "binding", "exit", "exitFadeMs", "reentry", "start", "end", "crossfadeShape", "exitShape"].includes(k)) r.problem(`${where}.${k}`, "not a loop field; dropped.");
  }
  return out;
}

/** An override as JSON, fields in a stable order. */
export function loopOverrideToJson(o: LoopOverride): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.start !== undefined) out.start = o.start;
  if (o.end !== undefined) out.end = o.end;
  if (o.active !== undefined) out.active = o.active;
  if (o.binding) out.binding = { ...o.binding };
  if (o.exit !== undefined) out.exit = o.exit;
  if (o.exitFadeMs !== undefined) out.exitFadeMs = o.exitFadeMs;
  if (o.reentry !== undefined) out.reentry = o.reentry;
  writeShapes(o, out);
  return out;
}
