/**
 * A playlist's `effects` at runtime (ADR 0345: "once per playing instance, on its mixed output"), the one adapter:
 *
 * - **The instance's own chain** (its root playlist or sequence) runs on the instance's submix when the backend has one
 *   free (`AudioSubmixes.open`, from `PlaylistInstance.start`): `instanceChain` is what it sends, and the root level's
 *   effects aren't mapped onto its voices (`bodyCtx` skips them).
 * - **Every other level's chain** (a nested playlist's, a sequence track's, a sequence clip's; ABI 4.9) runs on a submix
 *   of its own (`levelEffects`, `NodeHost.levelSubmix`): the level's voices mix into it, and it feeds the submix of the
 *   level above it on the same bus (else the bus), so a nested playlist's EQ applies to its own voices only and a clip's
 *   delay rings on after the clip's voice ends (the submix keeps running until the instance's tails are out).
 * - **Otherwise** (no submix on this backend, no instance group, or the pool full) `playlistEffectProps` maps low-pass,
 *   high-pass and gain onto each voice's own filter and gain (they commute with the mix, so the result is the same as on
 *   a submix for those three), and every other type is skipped with one warning per type.
 */
import { effectParamValue } from "../../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../../engine/audio/effects/types";
import type { EffectProps } from "../../../../engine/audio/playlist/accumulate";
import { warnOnce } from "../core/handle";
import type { Ctx, CtxSubmix, NodeHost } from "./liveNode";

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
        warnOnce(`playlist:effect:${e.type}`, `[myco] ${where}: playlist effect "${e.type}" runs on a submix (ADR 0345), and this one plays without one (no submix on this backend, no instance group, or the pool full); skipped. Low-pass, high-pass and gain apply per voice.`);
    }
  }
  cache.set(effects, out);
  return out;
}

/** The effects an instance's submix runs: the enabled ones, in order (empty: the instance needs no submix). */
export function instanceChain(effects: readonly Effect[]): readonly Effect[] {
  if (!effects.some((e) => e.on)) return NO_EFFECTS;
  let hit = chains.get(effects);
  if (!hit) chains.set(effects, (hit = effects.filter((e) => e.on)));
  return hit;
}
const NO_EFFECTS: readonly Effect[] = [];
/** One chain per effects list (by identity), so a level played again sends the same list. */
const chains = new WeakMap<readonly Effect[], readonly Effect[]>();

/**
 * ADR 0345 levels: a level's chain below `parent` (the context above it): on a submix of its own when the host gives one
 * (`submix`: the context's for the voices below, no `fx` to map), else mapped onto the voices (`fx`), the voices then
 * staying in the submix above when they play on its bus. `bus` is the level's output (undefined: inherited), `key` names
 * the level within its instance.
 */
export function levelEffects(host: NodeHost, parent: Ctx, effects: readonly Effect[], bus: string | undefined, key: string, where: string): { fx?: Partial<EffectProps>; submix: CtxSubmix | null } {
  const resolved = host.resolveBus ? host.resolveBus(bus) : (bus ?? "Master");
  const above = parent.submix && parent.submix.bus === resolved ? parent.submix : null;
  const chain = instanceChain(effects);
  if (chain.length === 0) return { submix: above };
  const level = host.levelSubmix?.(key, chain, resolved, above ? above.level : null, where) ?? null;
  if (level) return { submix: { level, bus: resolved, root: false } };
  return { fx: playlistEffectProps(effects, where), submix: above };
}
