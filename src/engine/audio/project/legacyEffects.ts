/**
 * Internal (ADR 0330, 0331): how the mix's effects map onto the runtime's current bus effects (`BusEffect`: low-pass,
 * high-pass, compressor and the reverb send) and back. The runtime's views (`runtimeView.ts`) map one way, the migration and the legacy
 * panels' adapter (`legacy.ts`) the other. One place, so the two directions can't drift apart.
 *
 * Parameter names, ranges and defaults are the catalogue's (`effects/catalogue.ts`, ADR 0331); `RUNTIME_FIELDS` is the
 * one table that says which runtime field each catalogue parameter is and how its unit converts (`frequency` and
 * `cutoff`, `q` and `resonance` linearly over `Q_RANGE`, seconds and milliseconds). Every direction below reads it.
 *
 * Pure; no plugin, no DOM.
 */
import { clampEffectParam, defaultEffect, effectParamSpec, effectParamValue } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import type { BusEffect } from "../settings";
import type { AudioProject } from "./types";

/** A filter's `q` at resonance 0 and 1. */
export const Q_RANGE = [0.5, 20] as const;
/** A low-pass at or above this cutoff is open: the bypass-neutral setting a migrated snapshot or automation low-pass rests at. */
export const OPEN_CUTOFF = 20000;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export const qOfResonance = (r: number): number => round6(Q_RANGE[0] + Math.min(1, Math.max(0, r)) * (Q_RANGE[1] - Q_RANGE[0]));
export const resonanceOfQ = (q: number): number => Math.min(1, Math.max(0, (q - Q_RANGE[0]) / (Q_RANGE[1] - Q_RANGE[0])));
/** Milliseconds from seconds, rounded to a nanosecond so 0.07 s is 70 ms. */
export const msOf = (s: number): number => round6(s * 1000);
/** Seconds from milliseconds. */
export const secondsOf = (ms: number): number => Math.round(ms * 1e6) / 1e9;

type MappedType = "lowpass" | "highpass" | "compressor";
type RuntimeBusEffect = Extract<BusEffect, { type: MappedType }>;

/** One runtime field of a mapped bus effect: the catalogue parameter it is, and its unit conversion each way. */
export interface RuntimeField {
  field: string;
  param: string;
  toRuntime(value: number): number;
  toParam(value: number): number;
}

const same = (v: number): number => v;
const field = (name: string, param: string, toRuntime = same, toParam = same): RuntimeField => Object.freeze({ field: name, param, toRuntime, toParam });
const FILTER_FIELDS: readonly RuntimeField[] = Object.freeze([field("frequency", "cutoff"), field("q", "resonance", qOfResonance, resonanceOfQ)]);

/** The one legacy/catalogue table: every runtime bus effect field and the catalogue parameter it maps to. */
export const RUNTIME_FIELDS: Readonly<Record<MappedType, readonly RuntimeField[]>> = Object.freeze({
  lowpass: FILTER_FIELDS,
  highpass: FILTER_FIELDS,
  compressor: Object.freeze([
    field("threshold", "threshold"), field("knee", "knee"), field("ratio", "ratio"),
    field("attack", "attack", secondsOf, msOf), field("release", "release", secondsOf, msOf),
  ]),
});

/** An effect's parameter, with the catalogue default when it leaves it out (0 for a name its type doesn't have). */
export const param = (e: Effect, name: string): number => effectParamValue(e, name) ?? 0;

/** True when the runtime's bus chain has an equivalent of `e` (an `on` low-pass, high-pass or compressor). */
export const isMappable = (e: Effect): boolean => e.on && (e.type === "lowpass" || e.type === "highpass" || e.type === "compressor");

/**
 * True when `e`, on `owner`, is a low-pass carrier: open (cutoff at or above `OPEN_CUTOFF`) and named by a snapshot
 * override or an automation. The migration creates one per bus for the old snapshot and automation low-pass; the
 * runtime view leaves it out of the bus chain (it is neutral) and expresses what drives it as the old snapshot and
 * automation low-pass instead.
 */
export function isCarrier(project: Pick<AudioProject, "snapshots" | "automation">, owner: string, e: Effect): boolean {
  if (e.type !== "lowpass" || !e.on || param(e, "cutoff") < OPEN_CUTOFF) return false;
  if (project.snapshots.some((s) => s.effects[owner]?.[e.id] !== undefined)) return true;
  return project.automation.some((a) => a.on === owner && a.target.startsWith(`fx:${e.id}:`));
}

/** True when `e` appears in the runtime view's bus chain. */
export const isShown = (project: Pick<AudioProject, "snapshots" | "automation">, owner: string, e: Effect): boolean => isMappable(e) && !isCarrier(project, owner, e);

/**
 * The runtime bus effect of a mappable effect (`isMappable`), with what it can't carry in `lost`: each catalogue
 * parameter `RUNTIME_FIELDS` doesn't map (filter `drive`, compressor `makeup`) that isn't at its default.
 */
export function toBusEffect(e: Effect, lost: string[]): BusEffect {
  const type = e.type as MappedType;
  const fields = RUNTIME_FIELDS[type];
  const out: Record<string, unknown> = { type };
  for (const f of fields) out[f.field] = f.toRuntime(param(e, f.param));
  for (const name of Object.keys(defaultEffect(type, "").params)) {
    if (!fields.some((f) => f.param === name) && param(e, name) !== effectParamSpec(type, name)!.default) lost.push(name);
  }
  return out as unknown as BusEffect;
}

/** The params of a new effect made from a runtime bus effect (not the reverb send): every catalogue parameter, mapped ones from `b` fitted to the catalogue ranges (a legacy threshold below −60 dB reads as −60). */
export function paramsOf(b: RuntimeBusEffect): Record<string, number> {
  const params = defaultEffect(b.type, "").params;
  const fields = b as unknown as Record<string, number>;
  for (const f of RUNTIME_FIELDS[b.type]) params[f.param] = clampEffectParam(effectParamSpec(b.type, f.param)!, f.toParam(fields[f.field]));
  return params;
}

/**
 * `e`'s params after its runtime equivalent changed from `before` to `after` (same type): only the fields that changed
 * are rewritten, so a parameter the runtime rounds (resonance through `q`) keeps its exact value when untouched.
 */
export function updatedParams(e: Effect, before: BusEffect, after: BusEffect): Record<string, number> {
  const params = { ...e.params };
  if (after.type === "reverb" || after.type === "fx" || before.type !== after.type) return params;
  const was = before as unknown as Record<string, number>;
  const now = after as unknown as Record<string, number>;
  for (const f of RUNTIME_FIELDS[after.type]) if (now[f.field] !== was[f.field]) params[f.param] = clampEffectParam(effectParamSpec(after.type, f.param)!, f.toParam(now[f.field]));
  return params;
}
