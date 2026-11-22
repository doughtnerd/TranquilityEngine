/**
 * The trigger gate (ADR 0329 "Trigger gate"; the prototype's `_vlGate`, PL:1256–1265), in order:
 *
 * 1. **Cooldown:** refused when fewer than `cooldown` seconds have passed since the last *accepted* trigger.
 * 2. **Chance:** refused with probability `1 − chance` (one draw from the generator; none when chance is 1 or 0).
 * 3. **Max instances:** with `maxInstances` already alive, `refuse`, or steal enough of them (the oldest, the quietest,
 *    or the farthest from the listener) to make room. The caller fades the victims out (40 ms).
 *
 * Pure; no plugin, no DOM.
 */
import type { PlaybackRules } from "./types";

/** Why a trigger did not play. */
export type GateRefusal = "cooldown" | "chance" | "maxInstances";

/** A live instance as the gate sees it. */
export interface GateCandidate<T> {
  ref: T;
  /** When it started (any clock, the same for all). */
  startedAt: number;
  /** A level estimate, linear. */
  loudness: number;
  /** Distance to the listener; 0 for a flat instance. */
  distance: number;
}

export type GateResult<T> = { ok: true; steal: T[] } | { ok: false; reason: GateRefusal };

/** The steal fade, seconds. */
export const STEAL_FADE_SECONDS = 0.04;

/**
 * Runs the gate. `lastAccepted` is the time of the last accepted trigger (null: none) on `now`'s clock (seconds);
 * `live` the instances alive of this playlist (in start order).
 */
export function gateTrigger<T>(rules: Pick<PlaybackRules, "cooldown" | "chance" | "maxInstances" | "whenFull">, lastAccepted: number | null, now: number, rng: () => number, live: readonly GateCandidate<T>[]): GateResult<T> {
  if (rules.cooldown > 0 && lastAccepted !== null && now - lastAccepted < rules.cooldown) return { ok: false, reason: "cooldown" };
  if (rules.chance <= 0) return { ok: false, reason: "chance" };
  if (rules.chance < 1 && rng() >= rules.chance) return { ok: false, reason: "chance" };
  const max = rules.maxInstances;
  if (max <= 0 || live.length < max) return { ok: true, steal: [] };
  if (rules.whenFull === "refuse") return { ok: false, reason: "maxInstances" };
  const order = live.slice();
  switch (rules.whenFull) {
    case "stealQuietest": order.sort((a, b) => a.loudness - b.loudness || a.startedAt - b.startedAt); break;
    case "stealFarthest": order.sort((a, b) => b.distance - a.distance || a.startedAt - b.startedAt); break;
    default: order.sort((a, b) => a.startedAt - b.startedAt); break;
  }
  return { ok: true, steal: order.slice(0, live.length - max + 1).map((c) => c.ref) };
}
