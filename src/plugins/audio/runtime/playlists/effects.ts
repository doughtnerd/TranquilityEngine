/**
 * A playlist's `effects` at runtime (ADR 0331: "once per playing instance, on its mixed output"), the one adapter:
 *
 * - **The instance's own chain** (its root playlist or sequence) runs on the instance's submix when the backend has one
 *   free (`AudioSubmixes.open`, from `PlaylistInstance.start`): `instanceChain` is what it sends, and the root level's
 *   effects aren't mapped onto its voices (`bodyCtx` skips them).
 * - **Otherwise** (no submix on this backend, the pool full, or a nested playlist's, a track's or a clip's effects, which
 *   share the instance's one submix group: per-level submixes are a follow-up) `playlistEffectProps` maps low-pass,
 *   high-pass and gain onto each voice's own filter and gain (they commute with the mix, so the result is the same as on
 *   a submix for those three), and every other type is skipped with one warning per type.
 */
import { effectParamValue } from "../../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../../engine/audio/effects/types";
import type { EffectProps } from "../../../../engine/audio/playlist/accumulate";
import { warnOnce } from "../core/handle";

const cache = new WeakMap<readonly Effect[], Partial<EffectProps>>();

/** The voice-control part of a playlist's effect chain (`fx` of a level). Disabled effects are left out. */
export function playlistEffectProps(effects: readonly Effect[], where: string): Partial<EffectProps> {
  if (effects.length === 0) return {};
  const hit = cache.get(effects);
  if (hit) return hit;
  const out: Partial<EffectProps> = {};
  for (const e of effects) {
    if (!e.on) continue;
    switch (e.type) {
      case "lowpass": out.lowpass = Math.min(out.lowpass ?? Infinity, effectParamValue(e, "cutoff") ?? 20000); break;
      case "highpass": out.highpass = Math.max(out.highpass ?? 0, effectParamValue(e, "cutoff") ?? 20); break;
      case "gain": out.gainDb = (out.gainDb ?? 0) + (effectParamValue(e, "gain") ?? 0); break;
      default:
        warnOnce(`playlist:effect:${e.type}`, `[myco] ${where}: playlist effect "${e.type}" runs on an instance submix (ADR 0331), and this one plays without one (no submix on this backend, the pool full, or a nested playlist's, track's or clip's effect); skipped. Low-pass, high-pass and gain apply.`);
    }
  }
  cache.set(effects, out);
  return out;
}

/** The effects an instance's submix runs: the enabled ones, in order (empty: the instance needs no submix). */
export function instanceChain(effects: readonly Effect[]): readonly Effect[] {
  return effects.some((e) => e.on) ? effects.filter((e) => e.on) : [];
}
