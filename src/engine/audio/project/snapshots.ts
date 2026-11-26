/**
 * Internal (ADR 0344 "Snapshots blend"): the one snapshot model the runtime's mixer and the Studio share.
 *
 * - **Conditions:** `lt le eq ne ge gt between` on numeric parameters, `is not` on labelled ones (a true / false
 *   parameter is labelled ["false", "true"]; a text one also takes `contains starts`, read off its label), evaluated
 *   against parameter values (a labelled parameter's value is its label's index). A snapshot whose start is `base` is
 *   always on; `code` and `never` are off until game code (or an audition) starts them.
 * - **Resolution:** any number of snapshots can be active. Per bus, the Override snapshots that list the bus resolve by
 *   priority (equal priority: the one started last wins) and the Add snapshots that list it stack their offsets on top.
 *   An effect parameter takes the value of the winning Override snapshot that overrides it; Add snapshots never override
 *   parameters. A snapshot only affects what it lists (as Wwise states and FMOD snapshots scope properties). Each
 *   snapshot's contribution scales with its fade weight (0..1): an offset of `db` at weight `w` is `db × w`, so a weight
 *   ramped linearly is a linear ramp in dB.
 *
 * Moved from the Studio's Mixer (`src/studio/screens/mixer/snapshotBlend.ts`, which re-exports it) so the runtime and the
 * Studio run one model. Pure; no plugin, no DOM.
 */
import { isLabelled, type ParameterDef } from "../parameters";
import type { Snapshot, SnapshotCondition, SnapshotStart } from "./types";

/** Parameter values by name: a number, or a labelled parameter's label index. */
export type TestValues = Readonly<Record<string, number>>;

/** A parameter's value: the given one, else its default (a label's index). */
export function testValueOf(def: ParameterDef, values: TestValues): number {
  const v = values[def.name];
  if (v !== undefined && Number.isFinite(v)) return v;
  return isLabelled(def) ? Math.max(0, def.labels.indexOf(def.default)) : def.default;
}

/**
 * A parameter value as the conditions read it: a label becomes its index, a number stays. An unknown label is NaN, so
 * callers ignore it (Q21, ADR 0386) rather than storing -1 as "no label".
 */
export function valueOf(def: ParameterDef | undefined, value: number | string): number {
  if (typeof value === "number") return value;
  const i = def && isLabelled(def) ? def.labels.indexOf(value) : -1;
  return i >= 0 ? i : Number.NaN;
}

/** Whether one condition holds for the values; false for an unknown parameter or a mismatched op. */
export function conditionHolds(c: SnapshotCondition, params: readonly ParameterDef[], values: TestValues): boolean {
  const def = params.find((p) => p.name === c.parameter);
  if (!def) return false;
  const v = testValueOf(def, values);
  if (isLabelled(def)) {
    if (c.op === "contains" || c.op === "starts") {
      const now = (def.labels[Math.round(v)] ?? "").toLowerCase();
      const part = String(c.value).toLowerCase();
      return c.op === "contains" ? now.includes(part) : now.startsWith(part);
    }
    const want = typeof c.value === "string" ? def.labels.indexOf(c.value) : Math.round(c.value);
    if (c.op === "is") return want >= 0 && Math.round(v) === want;
    if (c.op === "not") return Math.round(v) !== want;
    return false;
  }
  if (typeof c.value !== "number") return false;
  const x = c.value;
  switch (c.op) {
    case "lt": return v < x;
    case "le": return v <= x;
    case "eq": return v === x;
    case "ne": return v !== x;
    case "ge": return v >= x;
    case "gt": return v > x;
    case "between": {
      const y = c.value2 ?? x;
      return v >= Math.min(x, y) && v <= Math.max(x, y);
    }
    default: return false;
  }
}

/** Whether a start would have the snapshot on with these values (base: always; code and never: off). */
export function startHolds(start: SnapshotStart, params: readonly ParameterDef[], values: TestValues): boolean {
  switch (start.kind) {
    case "base": return true;
    case "code":
    case "never": return false;
    case "conditions":
      if (start.conditions.length === 0) return false;
      return start.match === "all" ? start.conditions.every((c) => conditionHolds(c, params, values)) : start.conditions.some((c) => conditionHolds(c, params, values));
  }
}

/** The parameters a start reads (a `conditions` start's), for re-evaluating only on a change of one of them. */
export function startParameters(start: SnapshotStart): string[] {
  return start.kind === "conditions" ? [...new Set(start.conditions.map((c) => c.parameter))] : [];
}

// --- resolution ---------------------------------------------------------------------------------------------------------

/** A snapshot that is on, in the order they started (oldest first), with its fade weight (default 1). */
export interface ActiveSnapshot {
  readonly snapshot: Pick<Snapshot, "name" | "priority" | "combine" | "buses" | "effects">;
  readonly weight?: number;
}

export interface ResolvedMix {
  /** Bus or return name → summed dB offset. */
  readonly levels: Readonly<Record<string, number>>;
  /** Bus or return name → effect id → param → { value, from }. */
  readonly effects: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { readonly value: number; readonly from: string }>>>>>>;
  /** Per bus, the snapshots heard on it and how ("override", "add"), for the gain lanes' note. */
  readonly sources: Readonly<Record<string, readonly { readonly name: string; readonly how: "override" | "add" }[]>>;
}

/** Override entries in the order they stack: lowest priority first, then the earliest started; the last is the winner. */
const stackOrder = <T extends { priority: number; order: number }>(a: T, b: T): number => a.priority - b.priority || a.order - b.order;

/**
 * The mix the active snapshots make (ADR 0344's rules). `base` maps a bus's effect parameter to its base value, so a
 * fading override blends from it (absent: the override's value is used as is).
 *
 * At full weight the winning Override snapshot's value is the value. While snapshots fade, each Override crossfades from
 * what lies under it: the overrides of a bus stack from the lowest priority (and earliest start) up, each mixing
 * `under × (1 − w) + its value × w`, starting from the base (0 dB, or the effect's base value). So a higher-priority
 * snapshot fading in moves the bus smoothly from the lower one's level to its own instead of jumping (FMOD's snapshot
 * intensity), and a single snapshot's fade is a linear ramp in dB.
 */
export function resolveSnapshots(active: readonly ActiveSnapshot[], base?: (bus: string, effectId: string, param: string) => number | undefined): ResolvedMix {
  const levels: Record<string, number> = {};
  const sources: Record<string, { name: string; how: "override" | "add" }[]> = {};
  const overrides = new Map<string, { priority: number; order: number; db: number; weight: number; name: string }[]>();
  const params = new Map<string, { priority: number; order: number; value: number; weight: number; name: string; bus: string; id: string; param: string }[]>();
  active.forEach(({ snapshot: s, weight = 1 }, order) => {
    const w = Math.min(1, Math.max(0, weight));
    for (const [bus, db] of Object.entries(s.buses)) {
      if (s.combine === "add") {
        levels[bus] = (levels[bus] ?? 0) + db * w;
        (sources[bus] ??= []).push({ name: s.name, how: "add" });
      } else {
        const list = overrides.get(bus) ?? [];
        list.push({ priority: s.priority, order, db, weight: w, name: s.name });
        overrides.set(bus, list);
      }
    }
    if (s.combine === "add") return;
    for (const [bus, byId] of Object.entries(s.effects)) {
      for (const [id, ps] of Object.entries(byId)) {
        for (const [param, value] of Object.entries(ps)) {
          const key = `${bus}\u0000${id}\u0000${param}`;
          const list = params.get(key) ?? [];
          list.push({ priority: s.priority, order, value, weight: w, name: s.name, bus, id, param });
          params.set(key, list);
        }
      }
    }
  });
  for (const [bus, list] of overrides) {
    list.sort(stackOrder);
    let db = 0;
    for (const o of list) db = db * (1 - o.weight) + o.db * o.weight;
    levels[bus] = (levels[bus] ?? 0) + db;
    (sources[bus] ??= []).unshift({ name: list[list.length - 1]!.name, how: "override" });
  }
  const effects: Record<string, Record<string, Record<string, { value: number; from: string }>>> = {};
  for (const list of params.values()) {
    list.sort(stackOrder);
    const top = list[list.length - 1]!;
    const from = base?.(top.bus, top.id, top.param);
    let value = from ?? list[0]!.value;
    for (const o of list) value = from === undefined && o === list[0] ? o.value : value * (1 - o.weight) + o.value * o.weight;
    ((effects[top.bus] ??= {})[top.id] ??= {})[top.param] = { value, from: top.name };
  }
  return { levels, effects, sources };
}
