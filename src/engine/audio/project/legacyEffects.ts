/**
 * Internal (ADR 0330, 0331): how the mix's effects map onto the runtime's current bus effects (`BusEffect`: low-pass,
 * high-pass, compressor and the reverb send) and back. `toRuntimeSettings` maps one way, the migration and the legacy
 * panels' adapter (`legacy.ts`) the other. One place, so the two directions can't drift apart.
 *
 * Parameter names follow ADR 0331's catalogue table: filters `cutoff` (Hz), `resonance` (0..1), `drive` (%); the
 * compressor `threshold` (dB), `ratio`, `attack` and `release` (ms), `makeup` (dB). The runtime's `q` maps onto
 * `resonance` linearly over `Q_RANGE`; the compressor's `knee` (dB), which the catalogue doesn't list, is kept as a
 * parameter of that name so a migrated compressor sounds the same.
 *
 * Pure; no plugin, no DOM.
 */
import type { Effect } from "../effects/types";
import type { BusEffect } from "../settings";
import type { AudioProject } from "./types";

/** A filter's `q` at resonance 0 and 1. */
export const Q_RANGE = [0.5, 20] as const;
/** A low-pass at or above this cutoff is open: the bypass-neutral setting a migrated snapshot or automation low-pass rests at. */
export const OPEN_CUTOFF = 20000;

/**
 * Each mapped parameter's value when an effect leaves it out. TODO(ADR 0331): take these from the catalogue
 * (`effects/catalogue.ts`) once it merges; until then they are the runtime's own defaults, and the migration writes
 * every parameter, so a migrated mix doesn't depend on them.
 */
export const LOCAL_DEFAULTS = {
  lowpass: { cutoff: OPEN_CUTOFF, resonance: 0, drive: 0 },
  highpass: { cutoff: 20, resonance: 0, drive: 0 },
  compressor: { threshold: -24, ratio: 12, attack: 3, release: 250, makeup: 0, knee: 30 },
} as const;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export const qOfResonance = (r: number): number => round6(Q_RANGE[0] + Math.min(1, Math.max(0, r)) * (Q_RANGE[1] - Q_RANGE[0]));
export const resonanceOfQ = (q: number): number => Math.min(1, Math.max(0, (q - Q_RANGE[0]) / (Q_RANGE[1] - Q_RANGE[0])));
/** Milliseconds from seconds, rounded to a nanosecond so 0.07 s is 70 ms. */
export const msOf = (s: number): number => round6(s * 1000);
/** Seconds from milliseconds. */
export const secondsOf = (ms: number): number => Math.round(ms * 1e6) / 1e9;

/** An effect's parameter with the local default applied. */
export function param(e: Effect, name: string): number {
  const v = e.params[name];
  if (typeof v === "number") return v;
  const defaults = (LOCAL_DEFAULTS as Record<string, Record<string, number>>)[e.type];
  return defaults?.[name] ?? 0;
}

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

/** The runtime bus effect of a mappable effect (`isMappable`), with what it can't carry in `lost`. */
export function toBusEffect(e: Effect, lost: string[]): BusEffect {
  switch (e.type) {
    case "lowpass":
    case "highpass":
      if (param(e, "drive") !== 0) lost.push("drive");
      return { type: e.type, frequency: param(e, "cutoff"), q: qOfResonance(param(e, "resonance")) };
    default:
      if (param(e, "makeup") !== 0) lost.push("makeup");
      return {
        type: "compressor", threshold: param(e, "threshold"), knee: param(e, "knee"), ratio: param(e, "ratio"),
        attack: secondsOf(param(e, "attack")), release: secondsOf(param(e, "release")),
      };
  }
}

/** The params of a new effect made from a runtime bus effect (not the reverb send). Every mapped parameter is written. */
export function paramsOf(b: Exclude<BusEffect, { type: "reverb" }>): Record<string, number> {
  if (b.type === "compressor") return { threshold: b.threshold, ratio: b.ratio, attack: msOf(b.attack), release: msOf(b.release), makeup: 0, knee: b.knee };
  return { cutoff: b.frequency, resonance: resonanceOfQ(b.q), drive: 0 };
}

/**
 * `e`'s params after its runtime equivalent changed from `before` to `after` (same type): only the fields that changed
 * are rewritten, so a parameter the runtime rounds (resonance through `q`) keeps its exact value when untouched.
 */
export function updatedParams(e: Effect, before: BusEffect, after: BusEffect): Record<string, number> {
  const params = { ...e.params };
  if (after.type === "compressor" && before.type === "compressor") {
    if (after.threshold !== before.threshold) params.threshold = after.threshold;
    if (after.knee !== before.knee) params.knee = after.knee;
    if (after.ratio !== before.ratio) params.ratio = after.ratio;
    if (after.attack !== before.attack) params.attack = msOf(after.attack);
    if (after.release !== before.release) params.release = msOf(after.release);
  } else if ((after.type === "lowpass" || after.type === "highpass") && before.type === after.type) {
    if (after.frequency !== before.frequency) params.cutoff = after.frequency;
    if (after.q !== before.q) params.resonance = resonanceOfQ(after.q);
  }
  return params;
}
