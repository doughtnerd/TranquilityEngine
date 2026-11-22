// An effect chain's edits (ADR 0335 `EffectChain`, ADR 0331): the "Add effect" menu for a level (the catalogue's types
// that may run there, alphabetical), and each edit as a pure function from the chain to the next chain or a refusal
// (`{ next } | { refused }`, the audio editor's `EditResult`, ADR 0307/0313), so the owner applies it as one undo step
// through `applyEdit`. An edit that changes nothing returns the same list, which `applyEdit` skips. Removing an effect
// leaves its automation (`fx:<id>:<param>`) to the owner, which holds it.
import { allowedAt, clampEffectParam, defaultEffect, effectParamSpec, effectSpec, effectTypesAt } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel, EffectType } from "../../engine/audio/effects/types";
import type { EditResult } from "../../plugins/audio/editor/editResult";
import { formatParam } from "./parameterRowModel";

export type { EditResult };

/** One "Add effect" menu item. */
export interface EffectMenuItem {
  readonly type: EffectType;
  readonly label: string;
}

const LEVEL_NAME: Record<EffectLevel, string> = { sample: "a sample", voice: "a clip", instance: "a playlist", bus: "a bus" };

/** The types that may run at `level`, alphabetical by label. */
export function effectMenu(level: EffectLevel): EffectMenuItem[] {
  return effectTypesAt(level)
    .map((type) => ({ type, label: effectSpec(type).label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The first `fx<n>` id the chain doesn't use. */
export function nextEffectId(list: readonly Effect[]): string {
  const used = new Set(list.map((e) => e.id));
  for (let n = 1; ; n++) if (!used.has(`fx${n}`)) return `fx${n}`;
}

const at = (list: readonly Effect[], id: string) => list.findIndex((e) => e.id === id);
const gone = (id: string) => ({ refused: `there is no effect "${id}" in this chain` }) as const;
const replace = (list: readonly Effect[], i: number, effect: Effect): Effect[] => list.map((e, j) => (j === i ? effect : e));

/** Add a `type` effect with its defaults at the end (or at `index`). Refused at a level it can't run at, or a full chain. */
export function addEffect(list: readonly Effect[], type: EffectType, level: EffectLevel, options: { readonly limit?: number; readonly index?: number } = {}): EditResult<Effect[]> {
  const spec = effectSpec(type);
  if (!allowedAt(type, level)) return { refused: `${spec.label} can't run on ${LEVEL_NAME[level]} (it runs at ${spec.levels.join(", ")})` };
  if (options.limit !== undefined && list.length >= options.limit) return { refused: `at most ${options.limit} effects here` };
  const effect = defaultEffect(type, nextEffectId(list));
  const next = [...list];
  next.splice(Math.min(list.length, Math.max(0, options.index ?? list.length)), 0, effect);
  return { next };
}

/** Remove effect `id`. */
export function removeEffect(list: readonly Effect[], id: string): EditResult<Effect[]> {
  const i = at(list, id);
  if (i < 0) return gone(id);
  return { next: list.filter((_, j) => j !== i) };
}

/** Move effect `id` up (`delta` −1) or down (+1) the chain. Refused past either end. */
export function moveEffect(list: readonly Effect[], id: string, delta: number): EditResult<Effect[]> {
  const i = at(list, id);
  if (i < 0) return gone(id);
  const j = i + Math.sign(delta);
  if (delta === 0) return { next: list as Effect[] };
  if (j < 0) return { refused: "it is already first" };
  if (j >= list.length) return { refused: "it is already last" };
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return { next };
}

/** Turn effect `id` on, or off (bypassed). */
export function setEffectOn(list: readonly Effect[], id: string, on: boolean): EditResult<Effect[]> {
  const i = at(list, id);
  if (i < 0) return gone(id);
  const e = list[i]!;
  return { next: e.on === on ? (list as Effect[]) : replace(list, i, { ...e, on }) };
}

/** Set parameter `name` of effect `id`, held to its range. Refused for a parameter the type doesn't have. */
export function setEffectParam(list: readonly Effect[], id: string, name: string, value: number): EditResult<Effect[]> {
  const i = at(list, id);
  if (i < 0) return gone(id);
  const e = list[i]!;
  const q = effectParamSpec(e.type, name);
  if (!q) return { refused: `${effectSpec(e.type).label} has no parameter "${name}"` };
  if (!Number.isFinite(value)) return { refused: `${q.label} must be a number` };
  const v = clampEffectParam(q, value);
  return { next: e.params[name] === v ? (list as Effect[]) : replace(list, i, { ...e, params: { ...e.params, [name]: v } }) };
}

/** Set the key bus of sidechain effect `id` ("" for none). Refused for a type without a key, or keying on its own bus. */
export function setEffectKey(list: readonly Effect[], id: string, key: string, ownBus?: string): EditResult<Effect[]> {
  const i = at(list, id);
  if (i < 0) return gone(id);
  const e = list[i]!;
  if (effectSpec(e.type).key !== "bus") return { refused: `${effectSpec(e.type).label} takes no key bus` };
  if (ownBus !== undefined && key !== "" && key === ownBus) return { refused: "a bus can't key its own sidechain" };
  return { next: e.key === key ? (list as Effect[]) : replace(list, i, { ...e, key }) };
}

/** The buses a sidechain on `ownBus` may key on: every other bus except Master, in the order given. */
export const keyBusOptions = (buses: readonly string[], ownBus: string | undefined, master = "Master"): string[] => buses.filter((b) => b !== ownBus && b !== master);

/** A collapsed card's one-line summary: its first parameters' values ("800 Hz · 0.10"), or "Bypassed". */
export function effectSummary(effect: Effect, count = 2): string {
  if (!effect.on) return "Bypassed";
  const spec = effectSpec(effect.type);
  const parts = spec.params.slice(0, count).map((q) => formatParam(q, effect.params[q.name] ?? q.default));
  if (spec.key === "bus") parts.push(effect.key ? `key ${effect.key}` : "no key");
  return parts.join(" · ");
}

/** Why an effect in the chain won't play at `level` (it was moved from a level it can run at), or null. */
export function levelWarning(effect: Effect, level: EffectLevel): string | null {
  return allowedAt(effect.type, level) ? null : `${effectSpec(effect.type).label} doesn't run on ${LEVEL_NAME[level]}; it won't play here`;
}
