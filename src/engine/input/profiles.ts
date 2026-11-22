/**
 * Per-player input profiles (ADR 0337): binding overrides from rebinding, and accessibility
 * settings, applied by the evaluator. Saved with settings (ADR 0024) as `input.<profile>.json`.
 */
import type { World } from "../core/World";

/** Accessibility settings, per player (Rewired's input behaviours). Action names may be `"set.Id:action"` or bare. */
export interface InputAccessibility {
  /** Button actions that toggle on each press instead of being held. */
  holdToToggle?: string[];
  /** Vector or axis actions whose Y (or value) is flipped: look inversion. */
  invertY?: string[];
  /** Multipliers by action (look sensitivity). */
  sensitivity?: Record<string, number>;
  /** Replaces the stick dead zone (default 0.15) on every mapping that reads a stick or stick axis. */
  deadzone?: number;
}

/** What `input.<profile>.json` holds. */
export interface InputProfileData {
  format: 1;
  /** Control replacements: `"<context>/<mapping index>/<part>"` → control path. Parts: control, up, down, left, right, negative, positive, modifier0… */
  overrides: Record<string, string>;
  accessibility: InputAccessibility;
}

export interface PlayerProfile extends InputProfileData {
  /** Bumped on every change, so compiled tables rebuild. */
  version: number;
}

const perWorld = new WeakMap<World, Map<number, PlayerProfile>>();

/** @internal Player `index`'s profile in `world` (created empty on first use). */
export function profileOf(world: World, index: number): PlayerProfile {
  let m = perWorld.get(world);
  if (!m) perWorld.set(world, (m = new Map()));
  let p = m.get(index);
  if (!p) m.set(index, (p = { format: 1, overrides: {}, accessibility: {}, version: 0 }));
  return p;
}

/** @internal The key of one control of one mapping in `overrides`. */
export function overrideKey(context: string, mapping: number, part: string): string {
  return `${context}/${mapping}/${part}`;
}
