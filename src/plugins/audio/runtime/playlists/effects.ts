/**
 * A playlist's `effects` at runtime (ADR 0331: "once per playing instance, on its mixed output"). Until the core runs
 * instance submixes, this is the one adapter: low-pass, high-pass and gain effects map onto each voice's own filter and
 * gain (they commute with the mix, so the result is the same as on the submix for those three), and every other type is
 * skipped with one warning per type.
 *
 * TODO(ADR 0331 instance submixes): when the core has them, playlist effects run on the instance's submix and this
 * mapping goes.
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
        warnOnce(`playlist:effect:${e.type}`, `[myco] ${where}: playlist effect "${e.type}" needs instance submixes (ADR 0331), which the audio core doesn't have yet; skipped. Low-pass, high-pass and gain apply.`);
    }
  }
  cache.set(effects, out);
  return out;
}
