/**
 * Internal (ADR 0171 amended by 0172; api-and-models §6.2): live mix operations. An edit in Project Settings > Audio or
 * the Mixer panel is one `MixOp` (not a diff: a rename is `renameBus`, so a bus's voices, slot and held handles survive),
 * applied to the settings draft by `applyOpToDraft` and to the running mixer by `mixer.apply(op)`.
 *
 * Pure: no plugin, no DOM. Contract K0 declared the shapes; task Mo1 filled the functions.
 *
 * **One edit path.** The engine may not import the editor plugin, so the edit itself lives here, in
 * `applyOpToSettings`, and the model functions of `src/plugins/audio/editor/audioSettingsModel.ts` (`addBus`,
 * `removeBus`, `renameBus`, `setBusParent`, `setBusValue`, the effect, snapshot, ducking, automation, meter and target
 * functions) build an op and call `applyOpToDraft`: an op and the Project Settings UI edit the same way (§6.2's
 * "`applyOpToDraft` calls the model functions", read with the engine-imports-no-plugin rule).
 *
 * **Canonical form.** `applyOpToSettings` writes optional keys the way the parse and the model functions do: a bus's
 * `maxVoices`, `bed`, `bedPriority` and `meter` are absent when unset or at their default; `loudnessTargets` is absent
 * when it equals `DEFAULT_LOUDNESS_TARGETS`; `loudnessResetOnPlay` is absent when true. `diffOps(a, b)` applied to `a`
 * gives `b` for a canonical, valid `b` (the live keys, `LIVE_KEYS`; every other key is listed in `restartRequired`).
 *
 * **Refusals.** An op the parse would drop (an unknown bus, a duplicate name, a ninth metered bus, a rule whose target is
 * its trigger…) is refused: `opRefusal` says why and `applyOpToSettings` returns its input unchanged (the same object).
 */
import { CURVE_INTERPS, type Curve, type CurveKey } from "../core/curve";
import {
  BED_PRIORITY_LIMITS, BUS_BEDS, DEFAULT_BED_PRIORITY, EFFECT_TYPES, MAX_BUSES, ROOT_BED_PRIORITY, parseAudioSettings,
  type AudioSettings, type BusAutomation, type BusEffect, type BusSettings, type DuckingRule, type LoudnessTarget, type SnapshotSettings,
} from "./settings";

/** How an op reaches the core (§6.2's class table; architecture §4.7). */
export type OpClass = "direct" | "smoothed" | "dip" | "config" | "none";

/** The `OpClass` values as numbers, in the byte form's `u8 class` (the capture's MIXOP record, §5.3). */
export const OP_CLASS_CODES: Readonly<Record<OpClass, number>> = { direct: 0, smoothed: 1, dip: 2, config: 3, none: 4 };

/** Every op class, for tests and tables. */
export const OP_CLASSES: readonly OpClass[] = ["direct", "smoothed", "dip", "config", "none"];

/**
 * One live edit (§6.2). Index semantics, for every list op:
 * - `addBus.index`: the position in `audio.buses` (clamped to 1..length, the root stays first); absent: the end.
 *   `parent` unknown: the root (as the model's `addBus`).
 * - `addEffect.index`, `addSnapshot.index`: insert position (clamped to 0..length). `addSnapshot.name` absent: a unique
 *   "Snapshot", "Snapshot 2"…; `renameSnapshot.name` required.
 * - `setDucking` / `setAutomation` / `setTarget`: `rule` (or `target`) with `insert` inserts at `index` (0..length);
 *   without `insert` replaces the entry at `index`; `null` removes it.
 * - `setBus` values: `volume` number; `mute` boolean; `maxVoices` number or null (unlimited); `bed` a `BusBed` or null
 *   (the default); `bedPriority` number or null (the default); `meter` `"loudness"` or null (off).
 * - `setSnapshot.value` null: the bus is unlisted in that snapshot (multiplier 1, no low-pass).
 */
export type MixOp =
  | { op: "setBus"; bus: string; key: "volume" | "mute" | "maxVoices" | "bed" | "bedPriority" | "meter"; value: number | boolean | string | null }
  | { op: "addBus"; name: string; parent: string; index?: number }
  /** The bus and its descendants (`audioSettingsModel.ts` `removeBus`). */
  | { op: "removeBus"; bus: string }
  | { op: "renameBus"; from: string; to: string }
  | { op: "moveBus"; bus: string; parent: string }
  | { op: "addEffect"; bus: string; index: number; effect: BusEffect }
  | { op: "removeEffect"; bus: string; index: number }
  | { op: "moveEffect"; bus: string; from: number; to: number }
  | { op: "setEffect"; bus: string; index: number; key: string; value: number }
  | { op: "addSnapshot" | "removeSnapshot" | "renameSnapshot"; index: number; name?: string }
  | { op: "setSnapshot"; index: number; bus: string; key: "volume" | "lowpass"; value: number | null }
  | { op: "setDucking"; index: number; rule: DuckingRule | null; insert?: boolean }
  | { op: "setAutomation"; index: number; rule: BusAutomation | null; insert?: boolean }
  | { op: "setTarget"; index: number; target: LoudnessTarget | null; insert?: boolean }
  | { op: "setOption"; key: "loudnessResetOnPlay"; value: boolean };

/** The `op` names, in the byte form's `u8 op` order (index = code). Append only: a capture stores the code. */
export const MIX_OP_NAMES = [
  "setBus", "addBus", "removeBus", "renameBus", "moveBus", "addEffect", "removeEffect", "moveEffect", "setEffect",
  "addSnapshot", "removeSnapshot", "renameSnapshot", "setSnapshot", "setDucking", "setAutomation", "setTarget", "setOption",
] as const satisfies readonly MixOp["op"][];

/** What `audioEdit` registers for one undo step: the ops that made it and the ops that undo it (§6.4). */
export interface MixOpEntry { ops: MixOp[]; inverse: MixOp[] }

/**
 * What `mixer.apply(op)` / `AudioBackend.applyOp(op)` answers (§6.2). `deferred`: the edit is kept and applies later
 * (a bus add with no free slot, R10; the message says when). `restartRequired`: no live path serves it; it applies at
 * the next Play (the message names what).
 */
export interface ApplyResult { ok: boolean; class: OpClass; deferred?: string; restartRequired?: string }

/**
 * The settings draft an op edits: the panel's `SettingsDraft` (`src/editor/projectSettingsModel.ts`) or anything with an
 * `audio` section. Generic so the engine imports nothing of the editor.
 */
export interface MixDraft { audio?: unknown }

/** The byte form of one op (the capture's MIXOP record): `u8 op`, `u8 class`, `u16 argc`, `argc` u32 words (§6.2). */
export interface MixOpBytes { op: number; class: number; words: Uint32Array }

/** Resolves names to ids and bus names to `busRef` (`gen << 8 | slot`, §6.3) for the byte form. */
export interface MixOpNameTable {
  nameId(name: string): number;
  busRef(bus: string): number;
}

// --- limits and defaults the ops check (api-and-models §2.1; Ld5 may move them into settings.ts) ----------------------

/** §2.1: non-root buses that may carry `meter: "loudness"` (the root is always metered). */
export const MAX_LOUDNESS_BUSES = 8;
/** §2.1: entries of `loudnessTargets`, 1..8. */
export const MAX_LOUDNESS_TARGETS = 8;
/** §2.1: a target's name, up to 32 characters. */
export const MAX_TARGET_NAME = 32;
/** §2.1 (owner decision 4): `loudnessTargets` when absent; the first is the default target. */
export const DEFAULT_LOUDNESS_TARGETS: readonly Readonly<LoudnessTarget>[] = [
  { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
  { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
];

/** The `audio` keys a live op edits; every other key that differs is `restartRequired` in `diffOps`. */
export const LIVE_KEYS = ["buses", "snapshots", "ducking", "automation", "loudnessTargets", "loudnessResetOnPlay"] as const;

// --- helpers ---------------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural equality ignoring key order; a key holding `undefined` counts as absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
}

const clone = <T>(v: T): T => structuredClone(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clampInt = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)));
const isIndex = (i: unknown, len: number): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < len;
const isInsertIndex = (i: unknown, len: number): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) <= len;
const busOf = (a: AudioSettings, name: string): BusSettings | undefined => a.buses.find((b) => b.name === name);
const isRoot = (a: AudioSettings, name: string): boolean => a.buses[0]?.name === name;
const insertAt = <T>(list: readonly T[], index: number, item: T): T[] => [...list.slice(0, index), item, ...list.slice(index)];

function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

/** A bus's descendants, by name (depth first, as the model's `descendants`). */
function descendantsOf(a: AudioSettings, name: string): string[] {
  const out: string[] = [];
  for (const b of a.buses) if (b.parent === name && b.name !== name) out.push(b.name, ...descendantsOf(a, b.name));
  return out;
}

/** A `setBus` key's current value in op form (`null` for an absent optional key). */
function busValue(bus: BusSettings, key: Extract<MixOp, { op: "setBus" }>["key"]): number | boolean | string | null {
  return (bus[key] as number | boolean | string | undefined) ?? null;
}

/** `loudnessTargets` with the default applied (a copy). */
export function loudnessTargetsOf(a: Pick<AudioSettings, "loudnessTargets">): LoudnessTarget[] {
  return clone((a.loudnessTargets ?? DEFAULT_LOUDNESS_TARGETS) as LoudnessTarget[]);
}

const resetOnPlay = (a: AudioSettings): boolean => a.loudnessResetOnPlay ?? true;

const EFFECT_KEYS: Record<BusEffect["type"], readonly string[]> = {
  lowpass: ["frequency", "q"], highpass: ["frequency", "q"],
  compressor: ["threshold", "knee", "ratio", "attack", "release"], reverb: ["send"],
};

function effectRefusal(effect: unknown): string | null {
  if (!isObj(effect) || !(EFFECT_TYPES as readonly unknown[]).includes(effect.type)) return `An effect's type must be one of ${EFFECT_TYPES.join(", ")}.`;
  for (const k of EFFECT_KEYS[effect.type as BusEffect["type"]]) if (!finite(effect[k])) return `A ${effect.type as string} effect needs a number for ${k}.`;
  return null;
}

function duckingRefusal(a: AudioSettings, rule: DuckingRule): string | null {
  if (!busOf(a, rule.target) || !busOf(a, rule.trigger)) return "A ducking rule's target and trigger must name buses.";
  if (rule.target === rule.trigger) return "A bus can't duck itself.";
  if (![rule.amount, rule.attack, rule.release].every(finite)) return "A ducking rule needs numbers for amount, attack and release.";
  return null;
}

function targetRefusal(list: readonly LoudnessTarget[], t: LoudnessTarget, except: number): string | null {
  const name = typeof t.name === "string" ? t.name : "";
  if (name.trim() === "" || name.length > MAX_TARGET_NAME) return `A loudness target needs a name of 1 to ${MAX_TARGET_NAME} characters.`;
  if (list.some((o, i) => i !== except && o.name === name)) return `Another loudness target is already named "${name}".`;
  if (!finite(t.integrated) || t.integrated < -70 || t.integrated > 0) return "A loudness target's integrated level must be -70..0 LUFS.";
  if (!finite(t.tolerance) || t.tolerance < 0 || t.tolerance > 12) return "A loudness target's tolerance must be 0..12 LU.";
  if (!finite(t.truePeak) || t.truePeak < -20 || t.truePeak > 0) return "A loudness target's true peak must be -20..0 dBTP.";
  return null;
}

/** The index checks shared by `setDucking`, `setAutomation` and `setTarget`. */
function listRefusal(len: number, index: number, item: unknown, insert: boolean | undefined, what: string): string | null {
  if (item === null) return insert ? `Nothing to insert in ${what}.` : isIndex(index, len) ? null : `No ${what} entry ${index}.`;
  if (insert) return isInsertIndex(index, len) ? null : `Can't insert at ${index} in ${what}.`;
  return isIndex(index, len) ? null : `No ${what} entry ${index}.`;
}

/**
 * Why `op` can't apply to `a` (the message the settings section and the Mixer show, e.g. "At most 8 buses can be
 * metered"), or null when it applies. An op that applies may still change nothing (a value set to what it is).
 */
export function opRefusal(a: AudioSettings, op: MixOp): string | null {
  const noBus = (name: string) => `No bus named "${name}".`;
  switch (op.op) {
    case "setBus": {
      if (!busOf(a, op.bus)) return noBus(op.bus);
      const v = op.value;
      switch (op.key) {
        case "volume": return finite(v) ? null : "A bus volume must be a number.";
        case "mute": return typeof v === "boolean" ? null : "A bus mute must be true or false.";
        case "maxVoices": case "bedPriority": return v === null || finite(v) ? null : `A bus ${op.key} must be a number or unset.`;
        case "bed": return v === null || (BUS_BEDS as readonly unknown[]).includes(v) ? null : `A bus bed must be one of ${BUS_BEDS.join(", ")}.`;
        case "meter": {
          if (v === null) return null;
          if (v !== "loudness") return 'A bus meter must be "loudness" or off.';
          if (isRoot(a, op.bus)) return `${op.bus} is always metered`;
          const others = a.buses.filter((b, i) => i > 0 && b.meter !== undefined && b.name !== op.bus).length;
          return others >= MAX_LOUDNESS_BUSES ? `At most ${MAX_LOUDNESS_BUSES} buses can be metered` : null;
        }
      }
      return null;
    }
    case "addBus": {
      const name = typeof op.name === "string" ? op.name.trim() : "";
      if (name === "") return "A bus needs a name.";
      if (busOf(a, name)) return `Another bus is already named "${name}".`;
      if (a.buses.length >= MAX_BUSES) return `At most ${MAX_BUSES} buses.`;
      if (op.index !== undefined && !Number.isInteger(op.index)) return "A bus index must be a whole number.";
      return null;
    }
    case "removeBus":
      if (!busOf(a, op.bus)) return noBus(op.bus);
      return isRoot(a, op.bus) ? `${op.bus} is the root bus and can't be removed.` : null;
    case "renameBus": {
      if (!busOf(a, op.from)) return noBus(op.from);
      const name = typeof op.to === "string" ? op.to.trim() : "";
      if (name === "") return "A bus needs a name.";
      return name !== op.from && busOf(a, name) ? `Another bus is already named "${name}".` : null;
    }
    case "moveBus":
      if (!busOf(a, op.bus)) return noBus(op.bus);
      if (!busOf(a, op.parent)) return noBus(op.parent);
      if (isRoot(a, op.bus)) return `${op.bus} is the root bus and has no parent.`;
      if (op.parent === op.bus || descendantsOf(a, op.bus).includes(op.parent)) return `${op.bus} can't feed itself or a bus under it.`;
      return null;
    case "addEffect":
      if (!busOf(a, op.bus)) return noBus(op.bus);
      if (!Number.isInteger(op.index)) return "An effect index must be a whole number.";
      return effectRefusal(op.effect);
    case "removeEffect": {
      const b = busOf(a, op.bus);
      if (!b) return noBus(op.bus);
      return isIndex(op.index, b.effects.length) ? null : `${op.bus} has no effect ${op.index}.`;
    }
    case "moveEffect": {
      const b = busOf(a, op.bus);
      if (!b) return noBus(op.bus);
      return isIndex(op.from, b.effects.length) && isIndex(op.to, b.effects.length) ? null : `${op.bus} has no effect ${isIndex(op.from, b.effects.length) ? op.to : op.from}.`;
    }
    case "setEffect": {
      const b = busOf(a, op.bus);
      if (!b) return noBus(op.bus);
      const fx = b.effects[op.index];
      if (!isIndex(op.index, b.effects.length) || !fx) return `${op.bus} has no effect ${op.index}.`;
      if (!EFFECT_KEYS[fx.type].includes(op.key)) return `A ${fx.type} effect has no ${op.key}.`;
      return finite(op.value) ? null : "An effect value must be a number.";
    }
    case "addSnapshot": {
      if (!Number.isInteger(op.index)) return "A snapshot index must be a whole number.";
      if (op.name === undefined) return null;
      const name = op.name.trim();
      if (name === "") return "A snapshot needs a name.";
      return a.snapshots.some((s) => s.name === name) ? `Another snapshot is already named "${name}".` : null;
    }
    case "removeSnapshot":
      return isIndex(op.index, a.snapshots.length) ? null : `No snapshot ${op.index}.`;
    case "renameSnapshot": {
      if (!isIndex(op.index, a.snapshots.length)) return `No snapshot ${op.index}.`;
      const name = op.name?.trim() ?? "";
      if (name === "") return "A snapshot needs a name.";
      return a.snapshots.some((s, i) => i !== op.index && s.name === name) ? `Another snapshot is already named "${name}".` : null;
    }
    case "setSnapshot":
      if (!isIndex(op.index, a.snapshots.length)) return `No snapshot ${op.index}.`;
      if (!busOf(a, op.bus)) return noBus(op.bus);
      return op.value === null || finite(op.value) ? null : "A snapshot value must be a number or unset.";
    case "setDucking":
      return listRefusal(a.ducking.length, op.index, op.rule, op.insert, "ducking") ?? (op.rule ? duckingRefusal(a, op.rule) : null);
    case "setAutomation":
      return listRefusal(a.automation.length, op.index, op.rule, op.insert, "automation")
        ?? (op.rule && !busOf(a, op.rule.bus) ? noBus(op.rule.bus) : null)
        ?? (op.rule && (!Array.isArray(op.rule.curve) || op.rule.curve.length === 0) ? "An automation curve needs at least one key." : null);
    case "setTarget": {
      const list = loudnessTargetsOf(a);
      const idx = listRefusal(list.length, op.index, op.target, op.insert, "loudnessTargets");
      if (idx) return idx;
      if (op.target === null) return list.length <= 1 ? "At least one loudness target is needed." : null;
      if (op.insert && list.length >= MAX_LOUDNESS_TARGETS) return `At most ${MAX_LOUDNESS_TARGETS} loudness targets.`;
      return targetRefusal(list, op.target, op.insert ? -1 : op.index);
    }
    case "setOption":
      return typeof op.value === "boolean" ? null : "loudnessResetOnPlay must be true or false.";
  }
}

/** A bus with `key` set to `value` in canonical form (defaults and unset values absent). */
function withBusKey(a: AudioSettings, bus: BusSettings, key: Extract<MixOp, { op: "setBus" }>["key"], value: number | boolean | string | null): BusSettings {
  const { [key]: _drop, ...rest } = bus;
  const root = isRoot(a, bus.name);
  switch (key) {
    case "volume": return { ...bus, volume: value as number };
    case "mute": return { ...bus, mute: value as boolean };
    case "maxVoices": return value === null ? (rest as BusSettings) : { ...bus, maxVoices: clampInt(value as number, 1, a.voices.logical) };
    case "bed": return value === null || value === (root ? "own" : "parent") ? (rest as BusSettings) : { ...bus, bed: value as BusSettings["bed"] };
    case "bedPriority": {
      if (value === null) return rest as BusSettings;
      const v = clampInt(value as number, ...BED_PRIORITY_LIMITS);
      return v === (root ? ROOT_BED_PRIORITY : DEFAULT_BED_PRIORITY) ? (rest as BusSettings) : { ...bus, bedPriority: v };
    }
    case "meter": return value === null ? (rest as BusSettings) : { ...bus, meter: "loudness" };
  }
}

/** A list edit: insert, replace or remove at `index`. */
function editList<T>(list: readonly T[], index: number, item: T | null, insert: boolean | undefined): T[] {
  if (item === null) return list.filter((_, i) => i !== index);
  return insert ? insertAt(list, index, clone(item)) : list.map((x, i) => (i === index ? clone(item) : x));
}

/** `a` after `op`, in canonical form; `a` itself (the same object) when the op is refused or changes nothing. */
export function applyOpToSettings(a: AudioSettings, op: MixOp): AudioSettings {
  if (opRefusal(a, op) !== null) return a;
  const mapBus = (name: string, f: (b: BusSettings) => BusSettings): AudioSettings => ({ ...a, buses: a.buses.map((b) => (b.name === name ? f(b) : b)) });
  switch (op.op) {
    case "setBus": {
      const bus = busOf(a, op.bus)!;
      const next = withBusKey(a, bus, op.key, op.value);
      return deepEqual(next[op.key], bus[op.key]) ? a : mapBus(op.bus, () => next);
    }
    case "addBus": {
      const name = op.name.trim();
      const parent = busOf(a, op.parent) ? op.parent : a.buses[0].name;
      const index = Math.min(a.buses.length, Math.max(1, op.index ?? a.buses.length));
      return { ...a, buses: insertAt(a.buses, index, { name, parent, volume: 1, mute: false, effects: [] }) };
    }
    case "removeBus": {
      const gone = new Set([op.bus, ...descendantsOf(a, op.bus)]);
      const scrub = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).filter(([k]) => !gone.has(k)));
      return {
        ...a,
        buses: a.buses.filter((b) => !gone.has(b.name)),
        snapshots: a.snapshots.map((s) => ({ ...s, volumes: scrub(s.volumes), lowpass: scrub(s.lowpass) })),
        ducking: a.ducking.filter((r) => !gone.has(r.target) && !gone.has(r.trigger)),
        automation: a.automation.filter((r) => !gone.has(r.bus)),
      };
    }
    case "renameBus": {
      const { from } = op, to = op.to.trim();
      if (to === from) return a;
      const fix = (n: string) => (n === from ? to : n);
      const re = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [fix(k), v]));
      return {
        ...a,
        buses: a.buses.map((b) => ({ ...b, name: fix(b.name), ...(b.parent !== undefined ? { parent: fix(b.parent) } : {}) })),
        snapshots: a.snapshots.map((s) => ({ ...s, volumes: re(s.volumes), lowpass: re(s.lowpass) })),
        ducking: a.ducking.map((r) => ({ ...r, target: fix(r.target), trigger: fix(r.trigger) })),
        automation: a.automation.map((r) => ({ ...r, bus: fix(r.bus) })),
      };
    }
    case "moveBus":
      return busOf(a, op.bus)!.parent === op.parent ? a : mapBus(op.bus, (b) => ({ ...b, parent: op.parent }));
    case "addEffect":
      return mapBus(op.bus, (b) => ({ ...b, effects: insertAt(b.effects, Math.min(b.effects.length, Math.max(0, op.index)), clone(op.effect)) }));
    case "removeEffect":
      return mapBus(op.bus, (b) => ({ ...b, effects: b.effects.filter((_, i) => i !== op.index) }));
    case "moveEffect": {
      if (op.from === op.to) return a;
      return mapBus(op.bus, (b) => {
        const effects = [...b.effects];
        const [fx] = effects.splice(op.from, 1);
        effects.splice(op.to, 0, fx);
        return { ...b, effects };
      });
    }
    case "setEffect": {
      const fx = busOf(a, op.bus)!.effects[op.index] as unknown as Record<string, number>;
      if (fx[op.key] === op.value) return a;
      return mapBus(op.bus, (b) => ({ ...b, effects: b.effects.map((e, i) => (i === op.index ? ({ ...e, [op.key]: op.value } as BusEffect) : e)) }));
    }
    case "addSnapshot": {
      const name = op.name?.trim() ?? uniqueName("Snapshot", a.snapshots.map((s) => s.name));
      const index = Math.min(a.snapshots.length, Math.max(0, op.index));
      return { ...a, snapshots: insertAt(a.snapshots, index, { name, volumes: {}, lowpass: {} }) };
    }
    case "removeSnapshot":
      return { ...a, snapshots: a.snapshots.filter((_, i) => i !== op.index) };
    case "renameSnapshot": {
      const name = op.name!.trim();
      if (a.snapshots[op.index].name === name) return a;
      return { ...a, snapshots: a.snapshots.map((s, i) => (i === op.index ? { ...s, name } : s)) };
    }
    case "setSnapshot": {
      const field = op.key === "volume" ? "volumes" : "lowpass";
      const s = a.snapshots[op.index];
      if ((s[field][op.bus] ?? null) === op.value) return a;
      const rec = { ...s[field] };
      if (op.value === null) delete rec[op.bus]; else rec[op.bus] = op.value;
      return { ...a, snapshots: a.snapshots.map((x, i) => (i === op.index ? ({ ...x, [field]: rec } as SnapshotSettings) : x)) };
    }
    case "setDucking":
      if (op.rule && !op.insert && deepEqual(a.ducking[op.index], op.rule)) return a;
      return { ...a, ducking: editList(a.ducking, op.index, op.rule, op.insert) };
    case "setAutomation":
      if (op.rule && !op.insert && deepEqual(a.automation[op.index], op.rule)) return a;
      return { ...a, automation: editList(a.automation, op.index, op.rule, op.insert) };
    case "setTarget": {
      const list = loudnessTargetsOf(a);
      if (op.target && !op.insert && deepEqual(list[op.index], op.target)) return a;
      const next = editList(list, op.index, op.target, op.insert);
      const { loudnessTargets: _drop, ...rest } = a;
      return deepEqual(next, DEFAULT_LOUDNESS_TARGETS) ? (rest as AudioSettings) : { ...a, loudnessTargets: next };
    }
    case "setOption": {
      if (resetOnPlay(a) === op.value) return a;
      const { loudnessResetOnPlay: _drop, ...rest } = a;
      return op.value ? (rest as AudioSettings) : { ...a, loudnessResetOnPlay: false };
    }
  }
}

/**
 * The next draft after `op`: the parsed section through `applyOpToSettings`, the live keys written back over the
 * draft's `audio` object (other keys stay as authored). `d` itself when nothing changes.
 */
export function applyOpToDraft<D extends MixDraft>(d: D, op: MixOp): D {
  const a = parseAudioSettings(d.audio).settings;
  const next = applyOpToSettings(a, op);
  if (next === a) return d;
  const audio: Record<string, unknown> = isObj(d.audio) ? { ...d.audio } : {};
  for (const key of LIVE_KEYS) {
    if (next[key] === undefined) delete audio[key];
    else audio[key] = next[key];
  }
  return { ...d, audio };
}

/**
 * How `op` reaches the core against `settings` (§6.2's class table, architecture §4.7): `direct` (`setBus` volume,
 * mute, maxVoices, meter; `setEffect` on a filter or send; `addEffect` at the end; `addBus`; snapshot, ducking,
 * automation and target edits), `smoothed` (`setEffect` on a compressor), `dip` (`moveBus`, `removeBus`, `removeEffect`,
 * `moveEffect`, `addEffect` before the end), `config` (`renameBus`, no wire; `setBus` bed and bedPriority; `setOption`),
 * `none` (refused, or changes nothing).
 */
export function opClass(op: MixOp, settings: AudioSettings): OpClass {
  if (applyOpToSettings(settings, op) === settings) return "none";
  switch (op.op) {
    case "setBus": return op.key === "bed" || op.key === "bedPriority" ? "config" : "direct";
    case "addBus": return "direct";
    case "removeBus": case "moveBus": case "removeEffect": case "moveEffect": return "dip";
    case "renameBus": return "config";
    case "addEffect": return op.index >= busOf(settings, op.bus)!.effects.length ? "direct" : "dip";
    case "setEffect": return busOf(settings, op.bus)!.effects[op.index].type === "compressor" ? "smoothed" : "direct";
    case "addSnapshot": case "removeSnapshot": case "renameSnapshot": case "setSnapshot":
    case "setDucking": case "setAutomation": case "setTarget":
      return "direct";
    case "setOption": return "config";
  }
}

/** The ops that re-create the removed buses `gone` (in `before`'s list order) with everything that named them. */
function restoreBuses(before: AudioSettings, gone: Set<string>): MixOp[] {
  const ops: MixOp[] = [], present = new Set(before.buses.filter((b) => !gone.has(b.name)).map((b) => b.name));
  const root = before.buses[0].name, moves: MixOp[] = [], fields: MixOp[] = [];
  before.buses.forEach((b, index) => {
    if (!gone.has(b.name)) return;
    const parent = b.parent !== undefined && present.has(b.parent) ? b.parent : root;
    ops.push({ op: "addBus", name: b.name, parent, index });
    present.add(b.name);
    if (b.parent !== undefined && parent !== b.parent) moves.push({ op: "moveBus", bus: b.name, parent: b.parent });
    if (b.volume !== 1) fields.push({ op: "setBus", bus: b.name, key: "volume", value: b.volume });
    if (b.mute) fields.push({ op: "setBus", bus: b.name, key: "mute", value: true });
    for (const key of ["maxVoices", "bed", "bedPriority", "meter"] as const) if (b[key] !== undefined) fields.push({ op: "setBus", bus: b.name, key, value: b[key]! });
    b.effects.forEach((effect, i) => fields.push({ op: "addEffect", bus: b.name, index: i, effect: clone(effect) }));
  });
  ops.push(...moves, ...fields);
  before.snapshots.forEach((s, index) => {
    for (const [bus, value] of Object.entries(s.volumes)) if (gone.has(bus)) ops.push({ op: "setSnapshot", index, bus, key: "volume", value });
    for (const [bus, value] of Object.entries(s.lowpass)) if (gone.has(bus)) ops.push({ op: "setSnapshot", index, bus, key: "lowpass", value });
  });
  before.ducking.forEach((rule, index) => { if (gone.has(rule.target) || gone.has(rule.trigger)) ops.push({ op: "setDucking", index, rule: clone(rule), insert: true }); });
  before.automation.forEach((rule, index) => { if (gone.has(rule.bus)) ops.push({ op: "setAutomation", index, rule: clone(rule), insert: true }); });
  return ops;
}

/** The inverse of a list op (`setDucking`, `setAutomation`, `setTarget`) against the list before it. */
function invertList<T>(list: readonly T[], index: number, item: T | null, insert: boolean | undefined): { index: number; item: T | null; insert?: true } {
  if (item === null) return { index, item: clone(list[index]), insert: true };
  return insert ? { index, item: null } : { index, item: clone(list[index]) };
}

/**
 * The ops that undo `op` applied to `before`: `applyOpToSettings` of them, in order, on
 * `applyOpToSettings(before, op)` gives `before` back (for a canonical `before`). Empty when `op` is refused or changes
 * nothing. A list, not one op: undoing `removeBus` re-adds the bus and its descendants with their values, effects,
 * snapshot entries, ducking rules and automation; undoing `removeSnapshot` re-adds its entries.
 */
export function invert(op: MixOp, before: AudioSettings): MixOp[] {
  if (applyOpToSettings(before, op) === before) return [];
  switch (op.op) {
    case "setBus": return [{ op: "setBus", bus: op.bus, key: op.key, value: busValue(busOf(before, op.bus)!, op.key) }];
    case "addBus": return [{ op: "removeBus", bus: op.name.trim() }];
    case "removeBus": return restoreBuses(before, new Set([op.bus, ...descendantsOf(before, op.bus)]));
    case "renameBus": return [{ op: "renameBus", from: op.to.trim(), to: op.from }];
    case "moveBus": return [{ op: "moveBus", bus: op.bus, parent: busOf(before, op.bus)!.parent! }];
    case "addEffect": {
      const len = busOf(before, op.bus)!.effects.length;
      return [{ op: "removeEffect", bus: op.bus, index: Math.min(len, Math.max(0, op.index)) }];
    }
    case "removeEffect": return [{ op: "addEffect", bus: op.bus, index: op.index, effect: clone(busOf(before, op.bus)!.effects[op.index]) }];
    case "moveEffect": return [{ op: "moveEffect", bus: op.bus, from: op.to, to: op.from }];
    case "setEffect": {
      const fx = busOf(before, op.bus)!.effects[op.index] as unknown as Record<string, number>;
      return [{ op: "setEffect", bus: op.bus, index: op.index, key: op.key, value: fx[op.key] }];
    }
    case "addSnapshot": return [{ op: "removeSnapshot", index: Math.min(before.snapshots.length, Math.max(0, op.index)) }];
    case "removeSnapshot": {
      const s = before.snapshots[op.index];
      return [
        { op: "addSnapshot", index: op.index, name: s.name },
        ...Object.entries(s.volumes).map(([bus, value]): MixOp => ({ op: "setSnapshot", index: op.index, bus, key: "volume", value })),
        ...Object.entries(s.lowpass).map(([bus, value]): MixOp => ({ op: "setSnapshot", index: op.index, bus, key: "lowpass", value })),
      ];
    }
    case "renameSnapshot": return [{ op: "renameSnapshot", index: op.index, name: before.snapshots[op.index].name }];
    case "setSnapshot": {
      const s = before.snapshots[op.index];
      return [{ ...op, value: (op.key === "volume" ? s.volumes : s.lowpass)[op.bus] ?? null }];
    }
    case "setDucking": {
      const r = invertList(before.ducking, op.index, op.rule, op.insert);
      return [{ op: "setDucking", index: r.index, rule: r.item, ...(r.insert ? { insert: true } : {}) }];
    }
    case "setAutomation": {
      const r = invertList(before.automation, op.index, op.rule, op.insert);
      return [{ op: "setAutomation", index: r.index, rule: r.item, ...(r.insert ? { insert: true } : {}) }];
    }
    case "setTarget": {
      const r = invertList(loudnessTargetsOf(before), op.index, op.target, op.insert);
      return [{ op: "setTarget", index: r.index, target: r.item, ...(r.insert ? { insert: true } : {}) }];
    }
    case "setOption": return [{ op: "setOption", key: "loudnessResetOnPlay", value: resetOnPlay(before) }];
  }
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const tails: number[] = [], prev: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

/** A name in neither list, for a temporary rename while two entries swap names. */
function tempName(taken: Iterable<string>, i: number): string {
  const set = new Set(taken);
  for (let n = 0; ; n++) { const name = `~${i}${n ? `.${n}` : ""}`; if (!set.has(name)) return name; }
}

/**
 * Ops that turn `before` into `after` (an outside edit, Compare); a rename it can't see is remove plus add, and so is
 * a bus whose place in the list changed. Top-level keys outside `LIVE_KEYS` that differ are listed in `restartRequired`
 * (no live path serves them: voices, backend, clip memory and format, codecs, spatial, limiter look-ahead, music rings,
 * rhythm mode, occlusion, zones…).
 */
export function diffOps(before: AudioSettings, after: AudioSettings): { ops: MixOp[]; restartRequired: string[] } {
  const ops: MixOp[] = [];
  let cur = before;
  const push = (op: MixOp) => {
    const next = applyOpToSettings(cur, op);
    if (next !== cur) { ops.push(op); cur = next; }
  };
  const parentOf = (name: string) => busOf(cur, name)?.parent;

  // The root: a different name is a rename (a bus already holding that name leaves first).
  const ra = after.buses[0].name;
  if (cur.buses[0].name !== ra) {
    if (busOf(cur, ra)) {
      for (const b of cur.buses) if (b.parent === ra) push({ op: "moveBus", bus: b.name, parent: cur.buses[0].name });
      push({ op: "removeBus", bus: ra });
    }
    push({ op: "renameBus", from: cur.buses[0].name, to: ra });
  }

  // Buses kept in place: the longest run of shared names in the same relative order. The rest leave and come back.
  const curIndex = new Map(cur.buses.map((b, i) => [b.name, i]));
  const shared = after.buses.slice(1).map((b) => b.name).filter((n) => curIndex.has(n) && n !== ra);
  const keepAt = longestIncreasing(shared.map((n) => curIndex.get(n)!));
  const kept = new Set([ra, ...shared.filter((_, i) => keepAt.has(i))]);
  for (const b of cur.buses.slice(1)) if (kept.has(b.name) && !kept.has(parentOf(b.name)!)) push({ op: "moveBus", bus: b.name, parent: ra });
  for (const b of [...cur.buses.slice(1)]) {
    if (!kept.has(b.name) && busOf(cur, b.name) && kept.has(parentOf(b.name)!)) push({ op: "removeBus", bus: b.name });
  }
  after.buses.forEach((b, index) => {
    if (index === 0 || busOf(cur, b.name)) return;
    push({ op: "addBus", name: b.name, parent: b.parent !== undefined && busOf(cur, b.parent) ? b.parent : ra, index });
  });
  // Parents, shallowest first, so a bus never moves under one of its own descendants.
  const depth = (name: string): number => { let n = 0; for (let p = busOf(after, name)?.parent; p !== undefined; p = busOf(after, p)?.parent) if (++n > after.buses.length) break; return n; };
  for (const b of [...after.buses.slice(1)].sort((x, y) => depth(x.name) - depth(y.name))) {
    if (b.parent !== undefined && parentOf(b.name) !== b.parent) push({ op: "moveBus", bus: b.name, parent: b.parent });
  }
  // Values: meters off before meters on, so the count never passes the cap on the way.
  for (const b of after.buses) if (b.meter === undefined && busOf(cur, b.name)!.meter !== undefined) push({ op: "setBus", bus: b.name, key: "meter", value: null });
  for (const b of after.buses) {
    for (const key of ["volume", "mute", "maxVoices", "bed", "bedPriority"] as const) {
      const want = busValue(b, key);
      if (!deepEqual(busValue(busOf(cur, b.name)!, key), want)) push({ op: "setBus", bus: b.name, key, value: want });
    }
  }
  for (const b of after.buses) if (b.meter !== undefined && busOf(cur, b.name)!.meter === undefined) push({ op: "setBus", bus: b.name, key: "meter", value: b.meter });
  // Effects: the common prefix by type is edited in place; the rest is removed from the end and appended.
  for (const b of after.buses) {
    const have = busOf(cur, b.name)!.effects;
    let p = 0;
    while (p < have.length && p < b.effects.length && have[p].type === b.effects[p].type) p++;
    for (let i = have.length - 1; i >= p; i--) push({ op: "removeEffect", bus: b.name, index: i });
    for (let i = p; i < b.effects.length; i++) push({ op: "addEffect", bus: b.name, index: i, effect: clone(b.effects[i]) });
    for (let i = 0; i < p; i++) {
      const fx = busOf(cur, b.name)!.effects[i] as unknown as Record<string, number>, want = b.effects[i] as unknown as Record<string, number>;
      for (const key of EFFECT_KEYS[b.effects[i].type]) if (fx[key] !== want[key]) push({ op: "setEffect", bus: b.name, index: i, key, value: want[key] });
    }
  }

  // Snapshots, by position: extras leave from the end, names swap through a temporary name, new ones append.
  for (let i = cur.snapshots.length - 1; i >= after.snapshots.length; i--) push({ op: "removeSnapshot", index: i });
  const wantedNames = new Set(after.snapshots.map((s) => s.name));
  for (let i = 0; i < cur.snapshots.length; i++) {
    const name = cur.snapshots[i].name;
    if (name !== after.snapshots[i].name && wantedNames.has(name)) {
      push({ op: "renameSnapshot", index: i, name: tempName([...cur.snapshots.map((s) => s.name), ...wantedNames], i) });
    }
  }
  for (let i = 0; i < cur.snapshots.length; i++) if (cur.snapshots[i].name !== after.snapshots[i].name) push({ op: "renameSnapshot", index: i, name: after.snapshots[i].name });
  for (let i = cur.snapshots.length; i < after.snapshots.length; i++) push({ op: "addSnapshot", index: i, name: after.snapshots[i].name });
  after.snapshots.forEach((s, index) => {
    for (const [key, field] of [["volume", "volumes"], ["lowpass", "lowpass"]] as const) {
      const have = cur.snapshots[index][field], want = s[field];
      for (const bus of new Set([...Object.keys(have), ...Object.keys(want)])) {
        if ((have[bus] ?? null) !== (want[bus] ?? null)) push({ op: "setSnapshot", index, bus, key, value: want[bus] ?? null });
      }
    }
  });

  // Ducking and automation, by position: extras leave from the end, differing entries are replaced, new ones append.
  for (let i = cur.ducking.length - 1; i >= after.ducking.length; i--) push({ op: "setDucking", index: i, rule: null });
  after.ducking.forEach((rule, index) => {
    if (index >= cur.ducking.length) push({ op: "setDucking", index, rule: clone(rule), insert: true });
    else if (!deepEqual(cur.ducking[index], rule)) push({ op: "setDucking", index, rule: clone(rule) });
  });
  for (let i = cur.automation.length - 1; i >= after.automation.length; i--) push({ op: "setAutomation", index: i, rule: null });
  after.automation.forEach((rule, index) => {
    if (index >= cur.automation.length) push({ op: "setAutomation", index, rule: clone(rule), insert: true });
    else if (!deepEqual(cur.automation[index], rule)) push({ op: "setAutomation", index, rule: clone(rule) });
  });

  // Loudness targets (unique names, 1..8): as snapshots, swapping names through a temporary name.
  const wantTargets = loudnessTargetsOf(after);
  for (let i = loudnessTargetsOf(cur).length - 1; i >= wantTargets.length; i--) push({ op: "setTarget", index: i, target: null });
  const wantedTargetNames = new Set(wantTargets.map((t) => t.name));
  loudnessTargetsOf(cur).forEach((t, i) => {
    if (t.name !== wantTargets[i].name && wantedTargetNames.has(t.name)) {
      push({ op: "setTarget", index: i, target: { ...t, name: tempName([...loudnessTargetsOf(cur).map((x) => x.name), ...wantedTargetNames], i) } });
    }
  });
  wantTargets.forEach((t, index) => {
    const have = loudnessTargetsOf(cur);
    if (index >= have.length) push({ op: "setTarget", index, target: clone(t), insert: true });
    else if (!deepEqual(have[index], t)) push({ op: "setTarget", index, target: clone(t) });
  });
  if (resetOnPlay(cur) !== resetOnPlay(after)) push({ op: "setOption", key: "loudnessResetOnPlay", value: resetOnPlay(after) });

  const live = new Set<string>(LIVE_KEYS);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const restartRequired = [...keys].filter((k) => !live.has(k) && !deepEqual((before as unknown as Record<string, unknown>)[k], (after as unknown as Record<string, unknown>)[k]));
  return { ops, restartRequired };
}

// --- the byte form (the capture's MIXOP record) ------------------------------------------------------------------------

const SET_BUS_KEYS = ["volume", "mute", "maxVoices", "bed", "bedPriority", "meter"] as const;
const DUCK_MODES = [undefined, "presence", "level"] as const;
const DUCK_DETECTORS = [undefined, "peak", "rms"] as const;
const AUTOMATION_TARGETS = ["volume", "lowpass"] as const;
/** Value tags of a nullable value word. */
const Tag = { Null: 0, False: 1, True: 2, Number: 3, String: 4 } as const;
/** Flag bits of a list op (`setDucking`, `setAutomation`, `setTarget`) and of an optional field. */
const Flag = { Item: 1, HasInsert: 2, Insert: 4 } as const;

const f64 = new DataView(new ArrayBuffer(8));

class Writer {
  readonly words: number[] = [];
  constructor(private readonly names: MixOpNameTable) {}
  u(n: number): void { this.words.push(n >>> 0); }
  f(x: number): void { f64.setFloat64(0, x, true); this.words.push(f64.getUint32(0, true), f64.getUint32(4, true)); }
  s(name: string): void { this.u(this.names.nameId(name)); }
  b(bus: string): void { this.u(this.names.busRef(bus)); }
  code<T>(list: readonly T[], v: T): void { const i = list.indexOf(v); if (i < 0) throw new Error(`encodeMixOp: unknown value ${String(v)}`); this.u(i); }
  value(v: number | boolean | string | null): void {
    if (v === null) this.u(Tag.Null);
    else if (typeof v === "boolean") this.u(v ? Tag.True : Tag.False);
    else if (typeof v === "number") { this.u(Tag.Number); this.f(v); }
    else { this.u(Tag.String); this.s(v); }
  }
  listFlags(item: unknown, insert: boolean | undefined): void {
    this.u((item !== null ? Flag.Item : 0) | (insert !== undefined ? Flag.HasInsert : 0) | (insert ? Flag.Insert : 0));
  }
  effect(e: BusEffect): void {
    this.code(EFFECT_TYPES, e.type);
    for (const k of EFFECT_KEYS[e.type]) this.f((e as unknown as Record<string, number>)[k]);
  }
}

class Reader {
  private at = 0;
  constructor(private readonly words: Uint32Array, private readonly names: { name(id: number): string; bus(ref: number): string }) {}
  u(): number { if (this.at >= this.words.length) throw new Error("decodeMixOp: record too short"); return this.words[this.at++]; }
  f(): number { f64.setUint32(0, this.u(), true); f64.setUint32(4, this.u(), true); return f64.getFloat64(0, true); }
  s(): string { return this.names.name(this.u()); }
  b(): string { return this.names.bus(this.u()); }
  code<T>(list: readonly T[]): T { const i = this.u(); if (i >= list.length) throw new Error(`decodeMixOp: bad code ${i}`); return list[i]; }
  value(): number | boolean | string | null {
    switch (this.u()) {
      case Tag.Null: return null;
      case Tag.False: return false;
      case Tag.True: return true;
      case Tag.Number: return this.f();
      case Tag.String: return this.s();
      default: throw new Error("decodeMixOp: bad value tag");
    }
  }
  listFlags(): { item: boolean; insert?: boolean } {
    const fl = this.u();
    return { item: (fl & Flag.Item) !== 0, ...(fl & Flag.HasInsert ? { insert: (fl & Flag.Insert) !== 0 } : {}) };
  }
  effect(): BusEffect {
    const type = this.code(EFFECT_TYPES);
    const e: Record<string, unknown> = { type };
    for (const k of EFFECT_KEYS[type]) e[k] = this.f();
    return e as unknown as BusEffect;
  }
  get done(): boolean { return this.at === this.words.length; }
}

/**
 * The byte form of `op`: indices and counts as u32 words, numbers as f64 bit patterns (two words, low word first,
 * exact), strings as `nameId`, existing buses as `busRef` (`addBus.name` and `renameBus.to` are new names: `nameId`),
 * optional and nullable fields behind a flag word, effects and enums as small codes.
 *
 * Layouts (after `u8 op`, `u8 class`, `u16 argc`): setBus bus, key, value(tag[, payload]) · addBus name, parent,
 * hasIndex[, index] · removeBus bus · renameBus from, to · moveBus bus, parent · addEffect bus, index, effect(type,
 * fields) · removeEffect bus, index · moveEffect bus, from, to · setEffect bus, index, key, f64 · add/remove/renameSnapshot
 * index, hasName[, name] · setSnapshot index, bus, key, value · setDucking index, flags[, target, trigger, mode, detector,
 * hasThreshold[, threshold], amount, attack, release] · setAutomation index, flags[, bus, parameter, target, keys, (x, y,
 * interp)…] · setTarget index, flags[, name, integrated, tolerance, truePeak] · setOption key, value.
 */
export function encodeMixOp(op: MixOp, cls: OpClass, names: MixOpNameTable): MixOpBytes {
  const w = new Writer(names);
  switch (op.op) {
    case "setBus": w.b(op.bus); w.code(SET_BUS_KEYS, op.key); w.value(op.value); break;
    case "addBus": w.s(op.name); w.b(op.parent); w.u(op.index !== undefined ? 1 : 0); if (op.index !== undefined) w.u(op.index); break;
    case "removeBus": w.b(op.bus); break;
    case "renameBus": w.b(op.from); w.s(op.to); break;
    case "moveBus": w.b(op.bus); w.b(op.parent); break;
    case "addEffect": w.b(op.bus); w.u(op.index); w.effect(op.effect); break;
    case "removeEffect": w.b(op.bus); w.u(op.index); break;
    case "moveEffect": w.b(op.bus); w.u(op.from); w.u(op.to); break;
    case "setEffect": w.b(op.bus); w.u(op.index); w.s(op.key); w.f(op.value); break;
    case "addSnapshot": case "removeSnapshot": case "renameSnapshot":
      w.u(op.index); w.u(op.name !== undefined ? 1 : 0); if (op.name !== undefined) w.s(op.name); break;
    case "setSnapshot": w.u(op.index); w.b(op.bus); w.code(AUTOMATION_TARGETS, op.key); w.value(op.value); break;
    case "setDucking": {
      w.u(op.index); w.listFlags(op.rule, op.insert);
      const r = op.rule;
      if (r) {
        w.b(r.target); w.b(r.trigger); w.code(DUCK_MODES, r.mode); w.code(DUCK_DETECTORS, r.detector);
        w.u(r.threshold !== undefined ? 1 : 0); if (r.threshold !== undefined) w.f(r.threshold);
        w.f(r.amount); w.f(r.attack); w.f(r.release);
      }
      break;
    }
    case "setAutomation": {
      w.u(op.index); w.listFlags(op.rule, op.insert);
      const r = op.rule;
      if (r) {
        w.b(r.bus); w.s(r.parameter); w.code(AUTOMATION_TARGETS, r.target); w.u(r.curve.length);
        for (const k of r.curve) { w.f(k[0]); w.f(k[1]); w.u(k.length > 2 ? CURVE_INTERPS.indexOf(k[2]!) + 1 : 0); }
      }
      break;
    }
    case "setTarget": {
      w.u(op.index); w.listFlags(op.target, op.insert);
      const t = op.target;
      if (t) { w.s(t.name); w.f(t.integrated); w.f(t.tolerance); w.f(t.truePeak); }
      break;
    }
    case "setOption": w.u(0); w.u(op.value ? 1 : 0); break;
  }
  if (w.words.length > 0xffff) throw new Error(`encodeMixOp: ${w.words.length} words is over the u16 argc`);
  return { op: MIX_OP_NAMES.indexOf(op.op), class: OP_CLASS_CODES[cls], words: Uint32Array.from(w.words) };
}

/** The op back from its byte form; `name(id)` and `bus(ref)` resolve what `encodeMixOp` interned. */
export function decodeMixOp(bytes: MixOpBytes, names: { name(id: number): string; bus(ref: number): string }): { op: MixOp; class: OpClass } {
  const name = MIX_OP_NAMES[bytes.op];
  const cls = OP_CLASSES[bytes.class];
  if (name === undefined) throw new Error(`decodeMixOp: unknown op ${bytes.op}`);
  if (cls === undefined) throw new Error(`decodeMixOp: unknown class ${bytes.class}`);
  const r = new Reader(bytes.words, names);
  const withInsert = (fl: { insert?: boolean }) => (fl.insert !== undefined ? { insert: fl.insert } : {});
  let op: MixOp;
  switch (name) {
    case "setBus": { const bus = r.b(); const key = r.code(SET_BUS_KEYS); op = { op: name, bus, key, value: r.value() }; break; }
    case "addBus": { const n = r.s(); const parent = r.b(); op = r.u() ? { op: name, name: n, parent, index: r.u() } : { op: name, name: n, parent }; break; }
    case "removeBus": op = { op: name, bus: r.b() }; break;
    case "renameBus": { const from = r.b(); op = { op: name, from, to: r.s() }; break; }
    case "moveBus": { const bus = r.b(); op = { op: name, bus, parent: r.b() }; break; }
    case "addEffect": { const bus = r.b(); const index = r.u(); op = { op: name, bus, index, effect: r.effect() }; break; }
    case "removeEffect": { const bus = r.b(); op = { op: name, bus, index: r.u() }; break; }
    case "moveEffect": { const bus = r.b(); const from = r.u(); op = { op: name, bus, from, to: r.u() }; break; }
    case "setEffect": { const bus = r.b(); const index = r.u(); const key = r.s(); op = { op: name, bus, index, key, value: r.f() }; break; }
    case "addSnapshot": case "removeSnapshot": case "renameSnapshot": {
      const index = r.u();
      op = r.u() ? { op: name, index, name: r.s() } : { op: name, index };
      break;
    }
    case "setSnapshot": { const index = r.u(); const bus = r.b(); const key = r.code(AUTOMATION_TARGETS); op = { op: name, index, bus, key, value: r.value() as number | null }; break; }
    case "setDucking": {
      const index = r.u(), fl = r.listFlags();
      let rule: DuckingRule | null = null;
      if (fl.item) {
        const target = r.b(), trigger = r.b(), mode = r.code(DUCK_MODES), detector = r.code(DUCK_DETECTORS);
        const threshold = r.u() ? r.f() : undefined;
        const amount = r.f(), attack = r.f(), release = r.f();
        rule = { target, trigger, ...(mode ? { mode } : {}), ...(detector ? { detector } : {}), ...(threshold !== undefined ? { threshold } : {}), amount, attack, release };
      }
      op = { op: name, index, rule, ...withInsert(fl) };
      break;
    }
    case "setAutomation": {
      const index = r.u(), fl = r.listFlags();
      let rule: BusAutomation | null = null;
      if (fl.item) {
        const bus = r.b(), parameter = r.s(), target = r.code(AUTOMATION_TARGETS), n = r.u();
        const curve: CurveKey[] = [];
        for (let i = 0; i < n; i++) {
          const x = r.f(), y = r.f(), interp = r.u();
          if (interp > CURVE_INTERPS.length) throw new Error("decodeMixOp: bad curve interpolation");
          curve.push(interp ? [x, y, CURVE_INTERPS[interp - 1]] : [x, y]);
        }
        rule = { bus, parameter, target, curve: curve as Curve };
      }
      op = { op: name, index, rule, ...withInsert(fl) };
      break;
    }
    case "setTarget": {
      const index = r.u(), fl = r.listFlags();
      let target: LoudnessTarget | null = null;
      if (fl.item) { const n = r.s(); const integrated = r.f(), tolerance = r.f(), truePeak = r.f(); target = { name: n, integrated, tolerance, truePeak }; }
      op = { op: name, index, target, ...withInsert(fl) };
      break;
    }
    case "setOption": r.u(); op = { op: name, key: "loudnessResetOnPlay", value: r.u() !== 0 }; break;
  }
  if (!r.done) throw new Error("decodeMixOp: trailing words");
  return { op, class: cls };
}
