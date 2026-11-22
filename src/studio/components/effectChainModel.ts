// An effect chain's edits (ADR 0335 `EffectChain`, ADR 0331): the "Add effect" menu for a level (the catalogue's types
// that may run there, alphabetical), and each edit as a pure function from the chain to the next chain or a refusal
// (`{ next } | { refused }`, the audio editor's `EditResult`, ADR 0307/0313), so the owner applies it as one undo step
// through `applyEdit`. An edit that changes nothing returns the same list, which `applyEdit` skips. Removing an effect
// leaves its automation (`fx:<id>:<param>`) to the owner, which holds it.
import { allowedAt, clampEffectParam, defaultEffect, effectParamSpec, effectSpec, effectTypesAt, pluginEffectNote, registeredPluginEffects } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel, EffectType } from "../../engine/audio/effects/types";
import type { EditResult } from "../../plugins/audio/editor/editResult";
import type { AudioPluginDebug, AudioPluginFaultReason } from "../../plugins/audio/runtime/debugTypes";
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

// --- plugin effects (ADR 0338 §9) ------------------------------------------------------------------------------------

/** The "Add effect" menu in groups: the built-ins, then each plugin's effects under its title (plugins by title). */
export interface EffectMenuGroups {
  readonly builtins: readonly EffectMenuItem[];
  readonly plugins: readonly { readonly plugin: string; readonly title: string; readonly version: string; readonly items: readonly EffectMenuItem[] }[];
}

/** The types that may run at `level`, in groups: the built-ins alphabetical, then each on plugin's alphabetical. */
export function effectMenuGroups(level: EffectLevel): EffectMenuGroups {
  const builtins: EffectMenuItem[] = [];
  const byPlugin = new Map<string, { plugin: string; title: string; version: string; items: EffectMenuItem[] }>();
  for (const item of effectMenu(level)) {
    const p = effectSpec(item.type).plugin;
    if (!p || p.name === null) {
      builtins.push(item);
      continue;
    }
    const group = byPlugin.get(p.name) ?? { plugin: p.name, title: p.title, version: p.version, items: [] };
    group.items.push(item);
    byPlugin.set(p.name, group);
  }
  return { builtins, plugins: [...byPlugin.values()].sort((a, b) => a.title.localeCompare(b.title)) };
}

/** Frames per quantum: a health row's instructions per quantum, per frame. */
const QUANTUM_FRAMES = 128;

const FAULT_WORDS: Readonly<Record<AudioPluginFaultReason, string>> = {
  trap: "trapped",
  budget: "over budget",
  grow: "grew its memory",
  nonFinite: "non-finite output",
  range: "output past ±64",
};

/** A byte count as the Studio shows memory ("64 KB", "1.0 MB"). */
export function memoryText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** A health row's faults, most first ("over budget ×2, trapped ×1"), or "no faults". */
export function faultsText(faults: Readonly<Record<AudioPluginFaultReason, number>>): string {
  const reasons = (Object.keys(FAULT_WORDS) as AudioPluginFaultReason[]).filter((r) => faults[r] > 0);
  const parts = reasons.sort((a, b) => faults[b] - faults[a]).map((r) => `${FAULT_WORDS[r]} ×${faults[r]}`);
  return parts.length ? parts.join(", ") : "no faults";
}

/** The instruction budget per frame `type`'s plugin declared (`budget.instructionsPerFrame`), or null. */
export const pluginBudget = (type: string): number | null => registeredPluginEffects().find((d) => d.spec.type === type)?.instructionsPerFrame ?? null;

/** One plugin effect's health, as the card's health row and the Profiler's Plugins rows show it. */
export interface PluginHealthView {
  readonly type: string;
  readonly plugin: string;
  /** "Live", "Loading", "Off after faults", "Didn't load". */
  readonly state: string;
  /** Instructions per frame per instance in use (the mean over the last window). */
  readonly perFrame: number;
  /** The declared budget per frame, when known. */
  readonly budget: number | null;
  /** `perFrame` against `budget` (1 is the whole budget); null without a budget. */
  readonly load: number | null;
  readonly faults: string;
  readonly memory: string;
  /** The row as one line: "Live · 41 of 300 instructions per frame · 64 KB · no faults". */
  readonly text: string;
  /** True when Reset plugin does something: faults to clear, or the effect is off after them. */
  readonly resettable: boolean;
}

const STATE_WORDS: Readonly<Record<AudioPluginDebug["state"], string>> = { live: "Live", loading: "Loading", disabled: "Off after faults", failed: "Didn't load" };

/** `row` (`Audio.debug().plugins`) as the Studio shows it. */
export function pluginHealthView(row: AudioPluginDebug, budget: number | null = pluginBudget(row.type)): PluginHealthView {
  const perFrame = Math.round(row.instructionsPerQuantum / QUANTUM_FRAMES / Math.max(1, row.inUse));
  const faults = faultsText(row.faults);
  const memory = memoryText(row.memoryBytes);
  const state = STATE_WORDS[row.state];
  const instr = budget !== null ? `${perFrame} of ${budget} instructions per frame` : `${perFrame} instructions per frame`;
  const anyFault = Object.values(row.faults).some((n) => n > 0);
  return {
    type: row.type,
    plugin: row.plugin,
    state,
    perFrame,
    budget,
    load: budget ? perFrame / budget : null,
    faults,
    memory,
    text: [state, instr, memory, faults].join(" · "),
    resettable: row.state === "disabled" || (row.state === "live" && anyFault),
  };
}

/** A plugin effect's card: its chip, whether it is greyed, its status line and its health. */
export interface PluginCardView {
  /** "Tremolo 1.0.0" (the plugin's title and version); the type when the plugin is missing. */
  readonly chip: string;
  /** The plugin is off or missing: the card is greyed and the effect passes audio through. */
  readonly greyed: boolean;
  /** Why the effect isn't running as set, or null when it is healthy. */
  readonly status: string | null;
  readonly health: PluginHealthView | null;
  readonly canReset: boolean;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** `effect`'s card from the catalogue (`pluginEffectNote`) and its health row, if the runtime has one; null for a built-in. */
export function pluginCardView(effect: Effect, row?: AudioPluginDebug | null): PluginCardView | null {
  const p = effectSpec(effect.type).plugin;
  if (!p) return null;
  const chip = p.state === "missing" ? effect.type : `${p.title} ${p.version}`.trim();
  if (p.state !== "on") {
    const note = pluginEffectNote(effect.type);
    return { chip, greyed: true, status: note ? capitalise(note.replace(/^\([^)]*\)\s*/, "")) : "Passes audio through", health: null, canReset: false };
  }
  const health = row ? pluginHealthView(row) : null;
  let status: string | null = null;
  if (row && health) {
    if (row.state === "failed") status = `Didn't load (${row.error ?? "the module was refused"}): passes audio through`;
    else if (row.state === "loading") status = "Loading: passes audio through until its module is ready";
    else if (row.state === "disabled") status = `Off after three faults within a second (${health.faults}): passes audio through until reset`;
    else if (health.faults !== "no faults") status = `Faulted: ${health.faults}; those blocks passed through dry`;
    else if (row.noInstance > 0) status = `No free instance ${times(row.noInstance)}: those uses pass audio through`;
    else if (row.starved > 0) status = `Over the shared instruction budget ${times(row.starved)}: those blocks passed through dry`;
  }
  return { chip, greyed: false, status, health, canReset: health?.resettable ?? false };
}
