/**
 * A Blend's voice envelope (ADR 0329 "Envelope (Blend)"; the prototype's PL:1150–1184): ADSR in milliseconds.
 *
 * - Attack ramps 0 → 1 linearly, decay 1 → sustain linearly, the sustain level holds until release, and release ramps
 *   linearly from the level held at release to 0.
 * - `morph` interpolates the low and high envelopes by where the input sits between the first and last entry; `zone`
 *   gives each entry the low/high lerp by its rank among the entries (lowest x is `low`, highest `high`).
 * - How long a voice holds before it releases on its own: looping entries hold until released; otherwise the longest
 *   one-shot entry's length, else `max(500, attack + decay + 300)` ms (`envelopeHoldMs`).
 *
 * Pure; no plugin, no DOM.
 */
import type { Adsr } from "./types";

/** `a` and `b` mixed by `t` (0 → a, 1 → b). */
export function lerpAdsr(a: Adsr, b: Adsr, t: number): Adsr {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  const m = (x: number, y: number): number => x + (y - x) * u;
  return { attackMs: m(a.attackMs, b.attackMs), decayMs: m(a.decayMs, b.decayMs), sustain: m(a.sustain, b.sustain), releaseMs: m(a.releaseMs, b.releaseMs) };
}

/** The level before release, `ms` after the start. */
export function adsrHeldLevel(e: Adsr, ms: number): number {
  if (ms <= 0) return e.attackMs > 0 ? 0 : 1;
  if (ms < e.attackMs) return ms / e.attackMs;
  const d = ms - e.attackMs;
  if (d < e.decayMs) return 1 + (e.sustain - 1) * (d / e.decayMs);
  return e.sustain;
}

/**
 * The level `ms` after the start, released `releasedAtMs` after the start (null: still held). 0 once the release has
 * run its course.
 */
export function adsrLevel(e: Adsr, ms: number, releasedAtMs: number | null): number {
  if (releasedAtMs === null || ms < releasedAtMs) return adsrHeldLevel(e, ms);
  const from = adsrHeldLevel(e, releasedAtMs);
  if (!(e.releaseMs > 0)) return 0;
  const r = (ms - releasedAtMs) / e.releaseMs;
  return r >= 1 ? 0 : from * (1 - r);
}

/** How long a voice with this envelope holds before releasing on its own (ms), given the longest one-shot length (null: unknown). */
export function envelopeHoldMs(e: Adsr, longestOneShotMs: number | null): number {
  if (longestOneShotMs !== null && longestOneShotMs > 0) return longestOneShotMs;
  return Math.max(500, e.attackMs + e.decayMs + 300);
}
